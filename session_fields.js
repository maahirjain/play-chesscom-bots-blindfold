// session_fields.js
//
// Task 5.2 (PLAN.md §5.2): baseline/training/evaluation selection, with
// training approach and verbal scaffolding fields.
//
// In-page fields beside 5.1's Start/Stop control cluster (the 5.1
// contract §2 reasoning applies unchanged: PLAN §(c) per-game step 2 —
// "Select Baseline, Training, or Evaluation and confirm remembered
// conditions" — happens on the game page immediately before step 3,
// "Click Start").
//
// Field ownership (contract §1.1): 5.2 owns exactly three fields —
// sessionCategory (1.1 metadata: baseline/training/evaluation),
// trainingApproach and verbalScaffolding (1.2 conditions, source
// 'manual'). The other five condition fields (botName,
// botDisplayedRating, playerColor, timeControl, assistanceSettings)
// are 5.4's (detected / manual completion); 5.2 stores them as
// documented placeholders (UNDETECTED_CONDITION_FIELDS) corrected
// later via the 1.2.4 change path.
//
// Three exports:
//
//   buildInitialConditions(selection, detectedFields) — pure.
//     selection: {sessionCategory, trainingApproach, verbalScaffolding}
//       (raw UI values). detectedFields: the five 5.4-owned fields as
//       {value, source} wrappers — REQUIRED, no silent default (the
//       caller passes the explicit placeholder). Returns the frozen
//       seven-field record via createInitialConditions: the two 5.2
//       fields as {value: trimmed-or-null, source: 'manual'} (blank ⇒
//       null, never ""), the five 5.4 fields passed through untouched.
//       TypeError on malformed input (the 1.2 error contract);
//       RangeError on a sessionCategory outside the 1.1 domain.
//
//   UNDETECTED_CONDITION_FIELDS — frozen placeholder for the five
//     5.4-owned fields: each {value: null, source: 'manual'},
//     documented as "no detection attempted at 5.2; 5.4 owns
//     detection and corrects provenance via the 1.2.4 path".
//     Rationale for 'manual' over 'observed' (contract §7): the
//     closed source vocabulary admits no "not yet attempted" value;
//     'observed' would falsely claim a detection attempt ("detection
//     attempted and found nothing"), actively misleading a downstream
//     reader into believing the DOM was probed. 'manual' asserts only
//     "not DOM-detected" — the smaller untruth.
//
//   installSessionFields(options) — renders the select + two text
//     inputs beside 5.1's control cluster (inserted immediately
//     before the cluster element when provided, so the DOM reads
//     [fields][Start][lights] — "select then Start"; fixed-corner
//     fallback otherwise, 2.8 precedent). Returns the 5.3 seam
//     handle {getSelection, setSelection, setEnabled,
//     getDetectedConditions}. options.getDetectedConditions is the
//     5.4 plug-in seam (default: () => UNDETECTED_CONDITION_FIELDS).
//     options.extensionVersion is required (injected — the 1.1
//     header: call sites inject the extension version; the Start
//     sequence mints metadata with it). Invalid options → TypeError
//     at install time. Never throws into page code (3.2 SF-1).
//
// No per-category field enforcement: PLAN §3(b) step 2 states "The
// recorder logs deviations but does not enforce these rules", so a
// training approach entered for a baseline session is stored
// truthfully. Inapplicability stays derivable from sessionCategory
// (a blank field is null per the 1.2 contract §2.5) — no third
// state, no UI hiding.
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape
// (including a malformed selection); RangeError = bad domain value
// (a sessionCategory outside baseline/training/evaluation);
// plain Error = unavailable platform capability (no document).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // The five 1.2 condition fields owned by 5.4 (detected / manual
  // completion). 5.2 stores them as placeholders only.
  var DETECTED_FIELD_NAMES = Object.freeze([
    'botName',
    'botDisplayedRating',
    'playerColor',
    'timeControl',
    'assistanceSettings'
  ]);

  // The two 1.2 condition fields owned by 5.2 (user-selected).
  var SELECTED_FIELD_NAMES = Object.freeze([
    'trainingApproach',
    'verbalScaffolding'
  ]);

  // Documented placeholder (contract §3.1): "no detection attempted
  // at 5.2; 5.4 owns detection and corrects provenance via the 1.2.4
  // path". 'manual' asserts only "not DOM-detected" — the smaller
  // untruth versus 'observed'.
  var UNDETECTED_CONDITION_FIELDS = Object.freeze({
    botName: Object.freeze({ value: null, source: 'manual' }),
    botDisplayedRating: Object.freeze({ value: null, source: 'manual' }),
    playerColor: Object.freeze({ value: null, source: 'manual' }),
    timeControl: Object.freeze({ value: null, source: 'manual' }),
    assistanceSettings: Object.freeze({ value: null, source: 'manual' })
  });

  var SELECT_PLACEHOLDER_VALUE = '';
  var SELECT_PLACEHOLDER_LABEL = 'Select…';
  // Honest adopted-unknown label (contract §3.4): shown disabled when
  // boot adoption recovers a session whose category echo is missing —
  // never the remembered default masquerading as the active session's
  // category.
  var ADOPTED_UNKNOWN_LABEL = 'Unknown (adopted session)';

  function shared() {
    if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) {
      return globalThis.BlindfoldSession;
    }
    return BlindfoldSession;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // buildInitialConditions(selection, detectedFields) → frozen
  // seven-field conditions record.
  //
  // selection.sessionCategory is validated (RangeError outside the 1.1
  // domain) but is NOT part of the conditions record — category is 1.1
  // metadata, stored by the session-save path. The two selected fields
  // are wrapped {value: raw, source: 'manual'}; createInitialConditions
  // normalizes (trim; blank ⇒ null, never "") and freezes.
  // detectedFields is required — no silent default: the caller passes
  // UNDETECTED_CONDITION_FIELDS explicitly when 5.4 has not run.
  function buildInitialConditions(selection, detectedFields) {
    var BS = shared();
    if (!isPlainObject(selection)) {
      throw new TypeError('selection must be an object');
    }
    if (typeof BS.isSessionCategory !== 'function' ||
        !BS.isSessionCategory(selection.sessionCategory)) {
      throw new RangeError(
        'selection.sessionCategory must be one of: ' +
        'baseline, training, evaluation');
    }
    if (!isPlainObject(detectedFields)) {
      throw new TypeError(
        'detectedFields must be an object of {value, source} wrappers');
    }
    if (typeof BS.createInitialConditions !== 'function') {
      throw new Error('session conditions factory is unavailable');
    }
    var input = {};
    var i, field;
    for (i = 0; i < SELECTED_FIELD_NAMES.length; i++) {
      field = SELECTED_FIELD_NAMES[i];
      // Raw UI value straight through: createInitialConditions
      // normalizes (trimmed non-empty ⇒ itself; blank ⇒ null).
      // Non-string non-null values are caller errors (TypeError) via
      // the 1.2 normalizer. Extra selection keys are ignored
      // (lenient-on-input); the two known fields are the contract.
      input[field] = {
        value: hasOwn(selection, field) ? selection[field] : null,
        source: 'manual'
      };
    }
    for (i = 0; i < DETECTED_FIELD_NAMES.length; i++) {
      field = DETECTED_FIELD_NAMES[i];
      if (!hasOwn(detectedFields, field)) {
        throw new TypeError('detectedFields is missing: ' + field);
      }
      // Passed through untouched — 5.2 never rewrites 5.4's fields.
      input[field] = detectedFields[field];
    }
    return BS.createInitialConditions(input);
  }

  function validateOptions(options) {
    if (!isPlainObject(options)) {
      throw new TypeError('options must be an object');
    }
    // The 1.1 header: call sites inject the extension version. Required
    // because the Start sequence mints session metadata with it.
    var extensionVersion = options.extensionVersion;
    if (typeof extensionVersion !== 'string' ||
        extensionVersion.trim() === '') {
      throw new TypeError('options.extensionVersion must be a non-empty string');
    }
    var getDetectedConditions = options.getDetectedConditions;
    if (getDetectedConditions === undefined) {
      getDetectedConditions = function () { return UNDETECTED_CONDITION_FIELDS; };
    }
    if (typeof getDetectedConditions !== 'function') {
      throw new TypeError('options.getDetectedConditions must be a function');
    }
    var beforeElement = options.beforeElement === undefined ?
      null : options.beforeElement;
    if (beforeElement !== null && !isPlainObject(beforeElement)) {
      throw new TypeError('options.beforeElement must be a DOM element or null');
    }
    return {
      extensionVersion: extensionVersion.trim(),
      getDetectedConditions: getDetectedConditions,
      beforeElement: beforeElement
    };
  }

  // installSessionFields(options) → 5.3 seam handle
  // {getSelection, setSelection, setEnabled, getDetectedConditions,
  //  element}.
  //
  // Write-once/disabled-while-active rule (contract §3.2, PLAN 1.2.1
  // "once at session start" + 5.3 "without silently changing a game's
  // recorded conditions"): setEnabled(false) disables the form;
  // setSelection while disabled is a no-op. 5.2 emits no
  // conditions_changed events — the initial record is stored, not
  // emitted (1.2.4 governs later changes; 5.4 owns that path).
  function installSessionFields(options) {
    var opts = validateOptions(options);

    var doc = (typeof document !== 'undefined') ? document : null;
    if (doc === null) {
      throw new Error('session fields require a document');
    }

    var span = doc.createElement('span');
    span.className = 'blindfold-session-fields';

    var select = doc.createElement('select');
    select.className = 'blindfold-session-category';
    select.setAttribute('aria-label', 'Session category');
    var placeholder = doc.createElement('option');
    placeholder.value = SELECT_PLACEHOLDER_VALUE;
    placeholder.textContent = SELECT_PLACEHOLDER_LABEL;
    select.appendChild(placeholder);
    var categories = ['baseline', 'training', 'evaluation'];
    var labels = { baseline: 'Baseline', training: 'Training', evaluation: 'Evaluation' };
    for (var ci = 0; ci < categories.length; ci++) {
      (function (cat) {
        var opt = doc.createElement('option');
        opt.value = cat;
        opt.textContent = labels[cat];
        select.appendChild(opt);
      })(categories[ci]);
    }
    span.appendChild(select);

    var approachInput = doc.createElement('input');
    approachInput.type = 'text';
    approachInput.className = 'blindfold-session-approach';
    approachInput.setAttribute('aria-label', 'Training approach');
    approachInput.setAttribute('placeholder', 'Training approach');
    span.appendChild(approachInput);

    var scaffoldingInput = doc.createElement('input');
    scaffoldingInput.type = 'text';
    scaffoldingInput.className = 'blindfold-session-scaffolding';
    scaffoldingInput.setAttribute('aria-label', 'Verbal scaffolding');
    scaffoldingInput.setAttribute('placeholder', 'Verbal scaffolding');
    span.appendChild(scaffoldingInput);

    // Placement: immediately before 5.1's control cluster when the
    // caller provides it (DOM reads [fields][Start][lights] — "select
    // then Start"); the 2.8 fixed-corner fallback otherwise.
    var usedFallback = false;
    if (opts.beforeElement && opts.beforeElement.parentNode) {
      opts.beforeElement.parentNode.insertBefore(span, opts.beforeElement);
    } else {
      var anchor = doc.getElementById('blindfold-chess-move-input');
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(span, anchor.nextSibling);
      } else {
        usedFallback = true;
        span.className += ' blindfold-session-fields-fallback';
        doc.body.appendChild(span);
      }
    }

    var enabled = true;
    // Tracks whether the placeholder option currently carries the
    // adopted-unknown label (restored on re-enable).
    var showingAdoptedUnknown = false;

    function getSelection() {
      return {
        sessionCategory: select.value === SELECT_PLACEHOLDER_VALUE ?
          null : select.value,
        trainingApproach: approachInput.value,
        verbalScaffolding: scaffoldingInput.value
      };
    }

    function setSelection(selection) {
      // Write-once rule: while the form is disabled (a session is
      // active) a programmatic set is a no-op — restoring defaults
      // can never rewrite an active session's record (5.3's seam
      // contract).
      if (!enabled) {
        return;
      }
      if (!isPlainObject(selection)) {
        throw new TypeError('selection must be an object');
      }
      var cat = selection.sessionCategory;
      if (cat === null || cat === undefined || cat === SELECT_PLACEHOLDER_VALUE) {
        select.value = SELECT_PLACEHOLDER_VALUE;
        restorePlaceholderLabel();
      } else if (typeof cat === 'string' && labels[cat]) {
        restorePlaceholderLabel();
        select.value = cat;
      } else {
        throw new RangeError(
          'selection.sessionCategory must be a session category or null');
      }
      if (selection.trainingApproach !== undefined) {
        approachInput.value = selection.trainingApproach === null ?
          '' : String(selection.trainingApproach);
      }
      if (selection.verbalScaffolding !== undefined) {
        scaffoldingInput.value = selection.verbalScaffolding === null ?
          '' : String(selection.verbalScaffolding);
      }
    }

    function restorePlaceholderLabel() {
      if (showingAdoptedUnknown) {
        placeholder.textContent = SELECT_PLACEHOLDER_LABEL;
        showingAdoptedUnknown = false;
      }
    }

    // Shows the adopted session's category in the disabled form
    // (contract §3.4). A null/unknown category shows the honest
    // disabled "Unknown (adopted session)" label — never the
    // remembered default masquerading as the active session's
    // category. Not part of the 5.3 seam: adoption is the control's
    // job, and it owns this presentation.
    function showAdoptedCategory(category) {
      if (typeof category === 'string' && labels[category]) {
        restorePlaceholderLabel();
        select.value = category;
      } else {
        placeholder.textContent = ADOPTED_UNKNOWN_LABEL;
        showingAdoptedUnknown = true;
        select.value = SELECT_PLACEHOLDER_VALUE;
      }
      setEnabled(false);
    }

    function setEnabled(on) {
      enabled = !!on;
      var disabled = !enabled;
      select.disabled = disabled;
      approachInput.disabled = disabled;
      scaffoldingInput.disabled = disabled;
      if (enabled) {
        // The adopted session is over; its unknown category must not
        // linger as a quasi-value. The user's own last selection stays
        // untouched (5.3 will formalize remembered defaults).
        if (showingAdoptedUnknown) {
          restorePlaceholderLabel();
          select.value = SELECT_PLACEHOLDER_VALUE;
        }
      }
    }

    function getDetectedConditions() {
      // The 5.4 plug-in runs at Start; a throwing plug-in must not
      // break Start (3.2 SF-1) — fall back to the honest placeholder.
      // (The control treats a throw here as "no detection attempted",
      // which is exactly what the placeholder documents.)
      try {
        var detected = opts.getDetectedConditions();
        if (isPlainObject(detected)) {
          return detected;
        }
      } catch (e) { /* fall through to the placeholder */ }
      return UNDETECTED_CONDITION_FIELDS;
    }

    return {
      element: span,
      select: select,
      approachInput: approachInput,
      scaffoldingInput: scaffoldingInput,
      getSelection: getSelection,
      setSelection: setSelection,
      setEnabled: setEnabled,
      showAdoptedCategory: showAdoptedCategory,
      getDetectedConditions: getDetectedConditions,
      getExtensionVersion: function () { return opts.extensionVersion; }
    };
  }

  BlindfoldSession.SESSION_FIELD_NAMES_52 = SELECTED_FIELD_NAMES;
  BlindfoldSession.DETECTED_FIELD_NAMES_52 = DETECTED_FIELD_NAMES;
  BlindfoldSession.UNDETECTED_CONDITION_FIELDS = UNDETECTED_CONDITION_FIELDS;
  BlindfoldSession.buildInitialConditions = buildInitialConditions;
  BlindfoldSession.installSessionFields = installSessionFields;
})();

// Node test shim. Content-script consumers use the BlindfoldSession global
// directly; only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
