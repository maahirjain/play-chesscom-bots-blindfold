// session_conditions.js
//
// Task 1.2 (PLAN.md §1.2.1–§1.2.4): session-conditions data contract.
//
// Dependency-free plain script. Loads as a content-script global (shares the
// guarded BlindfoldSession namespace with session_identity.js, which it does
// NOT modify), via importScripts() in a future MV3 service worker, or under
// Node via the module.exports shim at the end. Platform-independent by
// design: this module never touches extension APIs, the DOM, or storage.
//
// Semantics (per .autodev/evidence/1.2.contract.md):
// - Seven condition fields, each { value, source } with
//   source ∈ {'observed','manual'}. Provenance is mandatory: no defaulted
//   sources. When a value is null (unknown), the source records how the
//   unknown was determined (detection attempted ⇒ 'observed'; user left the
//   field blank ⇒ 'manual').
// - Unknown is null everywhere. No sentinel strings, no guessed defaults.
//   trainingApproach/verbalScaffolding are free-form strings — no taxonomy.
// - The initial record is created once at session start (§5.1 wiring is a
//   later task); later changes are change payloads folded with
//   applyConditionChange. No in-place update API exists.
// - Change payloads carry new values only. Previous values are derivable by
//   folding the stream, so they are never persisted (PLAN §3(a)).
// - No timestamps on the record: occurrence time comes from the 1.3 event
//   envelope. No derived values (seconds, counts, durations, categories).
//
// Error conventions (mirroring 1.1):
// - TypeError: wrong type/shape — including a missing field or a malformed
//   { value, source } wrapper.
// - RangeError: value outside an allowed domain — bad source, bad player
//   color, unknown field name.
// - plain Error: logic error — e.g. an empty change map.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  var CONDITION_FIELDS = Object.freeze([
    'trainingApproach',
    'verbalScaffolding',
    'botName',
    'botDisplayedRating',
    'playerColor',
    'timeControl',
    'assistanceSettings'
  ]);

  var CONDITION_SOURCES = Object.freeze(['observed', 'manual']);

  var PLAYER_COLORS = Object.freeze(['white', 'black']);

  var CONDITION_CHANGE_EVENT_TYPE = Object.freeze('conditions_changed');

  function isConditionField(s) {
    return typeof s === 'string' && CONDITION_FIELDS.indexOf(s) !== -1;
  }

  function isConditionSource(s) {
    return typeof s === 'string' && CONDITION_SOURCES.indexOf(s) !== -1;
  }

  function isPlayerColor(s) {
    return typeof s === 'string' && PLAYER_COLORS.indexOf(s) !== -1;
  }

  // Trimmed non-empty string → itself; null/undefined/empty/whitespace-only
  // → null (unknown stays unknown, never guessed, never ""). Non-string
  // non-null input is a caller error.
  function normalizeConditionString(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') {
      throw new TypeError('condition value must be a string or null');
    }
    var trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  }

  // The displayed rating: finite integer >= 0, or null when unknown.
  // No invented upper cap. Numeric strings, floats, negatives, NaN and
  // Infinity are caller errors.
  function normalizeBotRating(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new TypeError('botDisplayedRating must be an integer >= 0 or null');
    }
    return v;
  }

  // 'white' | 'black' | null. Domain model mirrors 1.1's sessionCategory:
  // anything outside the domain is a RangeError, including non-strings
  // (1.1 throws RangeError for sessionCategory: 1; this does the same for
  // playerColor: 1). Case and spelling are preserved evidence: 'White' or
  // 'w' is rejected, not coerced. Empty/whitespace-only strings mean "not
  // supplied" → null, consistent with normalizeConditionString.
  function normalizePlayerColor(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      var trimmed = v.trim();
      if (trimmed === '') return null;
      if (!isPlayerColor(trimmed)) {
        throw new RangeError("playerColor must be 'white', 'black', or null");
      }
      return trimmed;
    }
    throw new RangeError("playerColor must be 'white', 'black', or null");
  }

  // Flat map of Chess.com-side assistance-setting name → primitive, or null
  // when unknown. The key inventory is defined by the §3.3 DOM audit (later
  // task); this contract constrains only the container. Nested
  // objects/arrays are rejected — they would smuggle structured observations
  // past review. {} (observed, nothing to report) is distinct from null
  // (unknown); a known setting with an unreadable value is { name: null }.
  // Non-finite numbers are rejected: they are not plain-JSON values.
  function normalizeAssistanceSettings(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object' || Array.isArray(v)) {
      throw new TypeError('assistanceSettings must be a plain object or null');
    }
    var out = {};
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (typeof key !== 'string' || key === '') {
        throw new TypeError('assistanceSettings keys must be non-empty strings');
      }
      if (key === '__proto__') {
        // Assigning out['__proto__'] would hit the inherited setter and
        // silently drop the observation. Reject loudly instead: a setting
        // with this name cannot be represented in a plain JSON object.
        throw new TypeError("assistanceSettings key '__proto__' is not supported");
      }
      var val = v[key];
      if (val === null || val === undefined) {
        out[key] = null;
      } else if (typeof val === 'boolean') {
        out[key] = val;
      } else if (typeof val === 'string') {
        var trimmed = val.trim();
        out[key] = trimmed === '' ? null : trimmed;
      } else if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
          throw new TypeError(
            'assistanceSettings values must be finite numbers, booleans, strings, or null'
          );
        }
        out[key] = val;
      } else {
        throw new TypeError(
          'assistanceSettings values must be booleans, strings, numbers, or null'
        );
      }
    }
    return Object.freeze(out);
  }

  var FIELD_NORMALIZERS = {
    trainingApproach: normalizeConditionString,
    verbalScaffolding: normalizeConditionString,
    botName: normalizeConditionString,
    botDisplayedRating: normalizeBotRating,
    playerColor: normalizePlayerColor,
    timeControl: normalizeConditionString,
    assistanceSettings: normalizeAssistanceSettings
  };

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // Validates one { value, source } wrapper and returns a fresh frozen copy
  // with the value normalized per-field. Used for both initial records and
  // change payloads.
  function validateConditionField(field, wrapper) {
    if (!isConditionField(field)) {
      throw new RangeError('unknown condition field: ' + String(field));
    }
    if (wrapper === null || typeof wrapper !== 'object' || Array.isArray(wrapper)) {
      throw new TypeError(
        "condition '" + field + "' must be a { value, source } object"
      );
    }
    if (!isConditionSource(wrapper.source)) {
      throw new RangeError(
        "condition '" + field + "' source must be 'observed' or 'manual'"
      );
    }
    return Object.freeze({
      value: FIELD_NORMALIZERS[field](wrapper.value),
      source: wrapper.source
    });
  }

  // Creates the initial session-conditions record. Called exactly once per
  // session at Start (§5.1 wiring, later task). All seven fields are
  // required — an all-unknown session is a record of seven
  // { value: null, source } entries with honest per-field sources, not a
  // partial record. Returns a fresh frozen record.
  function createInitialConditions(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('input must be a conditions input object');
    }
    var i, field;
    for (i = 0; i < CONDITION_FIELDS.length; i++) {
      field = CONDITION_FIELDS[i];
      if (!hasOwn(input, field)) {
        throw new TypeError('missing condition field: ' + field);
      }
    }
    var keys = Object.keys(input);
    for (i = 0; i < keys.length; i++) {
      if (!isConditionField(keys[i])) {
        throw new TypeError('unexpected condition field: ' + keys[i]);
      }
    }
    var record = {};
    for (i = 0; i < CONDITION_FIELDS.length; i++) {
      field = CONDITION_FIELDS[i];
      record[field] = validateConditionField(field, input[field]);
    }
    return Object.freeze(record);
  }

  // Builds a conditions_changed payload from a non-empty map of known field
  // names → { value, source }. The payload contains only the changed fields;
  // unchanged conditions are absent, never repeated. A change back to unknown
  // is { value: null, source }.
  function createConditionChange(changes) {
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new TypeError('changes must be an object');
    }
    var names = Object.keys(changes);
    if (names.length === 0) {
      throw new Error('changes must contain at least one changed field');
    }
    var payload = {};
    for (var i = 0; i < names.length; i++) {
      payload[names[i]] = validateConditionField(names[i], changes[names[i]]);
    }
    return Object.freeze({ changes: Object.freeze(payload) });
  }

  // Validates a full SessionConditions record (shape, sources, value
  // domains). Re-normalization is idempotent: already-normalized values pass
  // through unchanged.
  function requireValidConditions(conditions) {
    if (conditions === null || typeof conditions !== 'object' ||
        Array.isArray(conditions)) {
      throw new TypeError('conditions must be a session conditions record');
    }
    var record = {};
    for (var i = 0; i < CONDITION_FIELDS.length; i++) {
      var field = CONDITION_FIELDS[i];
      if (!hasOwn(conditions, field)) {
        throw new TypeError('missing condition field: ' + field);
      }
      record[field] = validateConditionField(field, conditions[field]);
    }
    return record;
  }

  // Pure fold: applies a change payload to a conditions record and returns a
  // NEW frozen record with exactly the changed fields replaced. The input
  // record is never mutated. Event envelope (ID, refs, timestamps, sequence)
  // is task 1.3's; this is the payload-level fold only.
  function applyConditionChange(conditions, change) {
    requireValidConditions(conditions);
    if (change === null || typeof change !== 'object' || Array.isArray(change)) {
      throw new TypeError('change must be a condition change payload');
    }
    var validated = createConditionChange(change.changes);
    var next = {};
    for (var i = 0; i < CONDITION_FIELDS.length; i++) {
      var field = CONDITION_FIELDS[i];
      next[field] = hasOwn(validated.changes, field)
        ? validated.changes[field]
        : conditions[field];
    }
    return Object.freeze(next);
  }

  BlindfoldSession.CONDITION_FIELDS = CONDITION_FIELDS;
  BlindfoldSession.CONDITION_SOURCES = CONDITION_SOURCES;
  BlindfoldSession.PLAYER_COLORS = PLAYER_COLORS;
  BlindfoldSession.CONDITION_CHANGE_EVENT_TYPE = CONDITION_CHANGE_EVENT_TYPE;
  BlindfoldSession.isConditionField = isConditionField;
  BlindfoldSession.isConditionSource = isConditionSource;
  BlindfoldSession.isPlayerColor = isPlayerColor;
  BlindfoldSession.normalizeConditionString = normalizeConditionString;
  BlindfoldSession.normalizeBotRating = normalizeBotRating;
  BlindfoldSession.normalizeAssistanceSettings = normalizeAssistanceSettings;
  BlindfoldSession.createInitialConditions = createInitialConditions;
  BlindfoldSession.createConditionChange = createConditionChange;
  BlindfoldSession.applyConditionChange = applyConditionChange;
})();

// Node test shim. Content-script and importScripts() consumers use the
// BlindfoldSession global directly; only environments that provide CommonJS
// get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
