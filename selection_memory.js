// selection_memory.js
//
// Task 5.3 (PLAN.md §5.3): remember previous selections without silently
// changing a game's recorded conditions.
//
// The remembered selection is a UI-preference convenience, not
// experimental data: it lives in chrome.storage.local (extension-scoped,
// invisible to page JavaScript, survives restarts), never in §2's IDB
// raw-data stores. The remembered values may only ever flow INTO the
// pre-session form; they reach a stored session_metadata / conditions
// record exclusively through the normal, explicit Start path (which
// records exactly what the form shows at Start).
//
// Two exports:
//
//   createSelectionMemory({ storage }) → { restore, capture, STORAGE_KEY }
//     storage: required, promise-shaped {get, set, remove} (production: a
//       thin chrome.storage.local adapter built in content.js — this
//       module never touches the chrome global directly). Missing or
//       malformed → TypeError at construction.
//     restore(fieldsHandle) — async, never throws into page code
//       (3.2 SF-1): reads the key, validates, and calls
//       fieldsHandle.setSelection(clean) on success. Missing/corrupt/
//       unreadable → no-op (fields stay blank). No enabled-check is
//       performed here: the 5.2 write-once rule makes setSelection a
//       no-op while the form is disabled, so both orders of the
//       boot-adoption race are safe — adopted truth always wins over
//       remembered values.
//     capture(selection) — async, never throws: validates and writes
//       exactly {[STORAGE_KEY]: clean} via the adapter. A write failure
//       is swallowed — the session already started successfully and a
//       preference write must never affect it. Called once per
//       successful Start via the onSessionStarted hook; aborted Starts
//       capture nothing.
//
//   validateRememberedSelection(value) — pure, total: returns a clean
//     {sessionCategory, trainingApproach, verbalScaffolding} or null.
//     sessionCategory must be 'baseline' | 'training' | 'evaluation' |
//     null (anything else → the whole value is corrupt → null); the two
//     text fields are coerced via String() (null/undefined → '' — an
//     empty string is a legitimate remembered value, never the string
//     "null"). Unknown extra keys are ignored (lenient-on-input).
//     Returns null — never throws — for missing/corrupt/wrong-shaped
//     input, so a corrupt stored value can never break the page.
//
// The no-silent-change invariant (contract §6), four independent
// mechanisms, all pinned in V1:
//   1. Write-once (5.2, existing): setSelection while disabled is a no-op.
//   2. No record-write path (5.3): the module's only external surface is
//      the injected storage adapter — it cannot reach session-save, the
//      IDB stores, or the recorder channel.
//   3. Capture reads the live form at Start: the only defaults→record
//      flow goes through the explicit Start path.
//   4. No load-past-session path exists: nothing can write a past record
//      back into the form.
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// plain Error = unavailable platform capability.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // Versioned in the key (not in the value): a future shape change
  // gets a new key and the old value is simply never read.
  var STORAGE_KEY = 'blindfold.sessionSelection.v1';

  var VALID_CATEGORIES = ['baseline', 'training', 'evaluation'];

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function cleanText(v) {
    // null/undefined → '' (an empty string is a legitimate remembered
    // value); anything else coerced via String() — never the literal
    // string "null" from String(null).
    if (v === null || v === undefined) {
      return '';
    }
    return typeof v === 'string' ? v : String(v);
  }

  // validateRememberedSelection(value) → clean selection | null.
  // Total function: never throws, so corrupt storage can never break
  // the page.
  function validateRememberedSelection(value) {
    if (!isPlainObject(value)) {
      return null;
    }
    var cat = hasOwn(value, 'sessionCategory') ?
      value.sessionCategory : null;
    if (cat === undefined || cat === null) {
      cat = null;
    } else if (typeof cat !== 'string' ||
               VALID_CATEGORIES.indexOf(cat) === -1) {
      // An unknown category string corrupts the whole value — a
      // half-valid selection must never be restored.
      return null;
    }
    return Object.freeze({
      sessionCategory: cat,
      trainingApproach: cleanText(value.trainingApproach),
      verbalScaffolding: cleanText(value.verbalScaffolding)
    });
  }

  function validateStorage(storage) {
    if (!isPlainObject(storage) ||
        typeof storage.get !== 'function' ||
        typeof storage.set !== 'function' ||
        typeof storage.remove !== 'function') {
      throw new TypeError(
        'options.storage must be a promise-shaped {get, set, remove} adapter');
    }
    return storage;
  }

  // createSelectionMemory({ storage }) → { restore, capture, STORAGE_KEY }.
  function createSelectionMemory(options) {
    if (!isPlainObject(options)) {
      throw new TypeError('options must be an object');
    }
    var storage = validateStorage(options.storage);

    // Reads the raw stored value (or undefined when absent/unreadable).
    // Never throws: storage failures degrade to "no remembered
    // selection", never a broken install.
    function readStored() {
      var raw;
      try {
        raw = storage.get(STORAGE_KEY);
      } catch (e) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(raw).then(function (result) {
        // chrome.storage.local.get(key) resolves {[key]: value} (or
        // {} when absent); tolerate a bare value too.
        if (isPlainObject(result) && hasOwn(result, STORAGE_KEY)) {
          return result[STORAGE_KEY];
        }
        return undefined;
      }, function () {
        return undefined;
      });
    }

    // restore(fieldsHandle) → Promise<boolean>. Never throws into
    // page code (3.2 SF-1). Deliberately performs NO enabled-check:
    // the 5.2 write-once rule makes setSelection a no-op while the
    // form is disabled, so restore is safe to call unconditionally at
    // install — if boot adoption already disabled the form the restore
    // is a harmless no-op; if adoption lands later, showAdoptedCategory
    // overrides. Adopted truth always wins.
    function restore(fieldsHandle) {
      try {
        return readStored().then(function (raw) {
          var clean = validateRememberedSelection(raw);
          if (clean === null) {
            return false;
          }
          if (!isPlainObject(fieldsHandle) ||
              typeof fieldsHandle.setSelection !== 'function') {
            return false;
          }
          try {
            fieldsHandle.setSelection(clean);
          } catch (e) {
            return false;
          }
          return true;
        }).then(null, function () {
          return false;
        });
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    // capture(selection) → Promise<boolean>. Never throws: the session
    // already started successfully, and a preference write must never
    // affect it. Invalid selections write nothing.
    function capture(selection) {
      try {
        var clean = validateRememberedSelection(selection);
        if (clean === null) {
          return Promise.resolve(false);
        }
        var kv = {};
        kv[STORAGE_KEY] = clean;
        return Promise.resolve(storage.set(kv)).then(function () {
          return true;
        }, function () {
          return false;
        });
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    return Object.freeze({
      restore: restore,
      capture: capture,
      STORAGE_KEY: STORAGE_KEY
    });
  }

  BlindfoldSession.STORAGE_KEY_SELECTION_MEMORY = STORAGE_KEY;
  BlindfoldSession.validateRememberedSelection = validateRememberedSelection;
  BlindfoldSession.createSelectionMemory = createSelectionMemory;
})();

// Node test shim. Content-script consumers use the BlindfoldSession global
// directly; only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
