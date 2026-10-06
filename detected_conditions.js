// detected_conditions.js
//
// Task 5.4 (PLAN.md §5.4): show detected game conditions and allow manual
// completion of unavailable fields before recording.
//
// Dependency-free plain script. Loads as a content-script global (shares the
// guarded BlindfoldSession namespace), or under Node via the module.exports
// shim at the end. Platform-independent by design: the detection core never
// touches extension APIs or storage; only installConditionsPanel touches the
// DOM, and attachConditionsPanel is pure wiring.
//
// Detection honesty (the 3.3.4 precedent: "recording unreliably-observed
// 'hints' would manufacture evidence"): only playerColor is detected, via a
// selector and orientation logic that both have in-repo precedent
// (chess_utils.js getBoardElement "wc-chess-board"; squareToXY's
// classList.contains("flipped")). The other four 1.2 fields have NO verified
// in-game selector — inventing one would risk matching the wrong element
// and fabricating a condition — so they are manual-only in 5.4. The frozen
// CONDITION_PROBES table documents exactly this; a future V3 probe populates
// entries without new architecture. The AC3 code-scan pin forbids
// verified:true without a cited verification.
//
// Source semantics (the 1.2 contract): detection attempted ⇒ 'observed',
// even when the probe finds nothing ({value:null, source:'observed'} —
// "we looked, found nothing"). 'manual'-sourced nulls therefore mean
// exactly "no detection attempted for this field in 5.4".
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape (including a
// non-document argument to detectGameConditions); RangeError = bad domain;
// plain Error = unavailable platform capability (no document at install).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // The five 1.2 condition fields 5.4 owns (5.2 owns the other two plus
  // sessionCategory, which is 1.1 metadata).
  var DETECTED_FIELD_NAMES = Object.freeze([
    'botName',
    'botDisplayedRating',
    'playerColor',
    'timeControl',
    'assistanceSettings'
  ]);

  // CONDITION_PROBES — one frozen entry per field:
  // { field, verified, selectors, note }. Only playerColor is
  // verified:true; the rest ship verified:false with documented reasons.
  // A future V3 probe may populate selectors, but an entry may only be
  // marked verified:true with a cited verification (test or V3 evidence) —
  // the AC3 pin scans for exactly this.
  var CONDITION_PROBES = Object.freeze([
    Object.freeze({
      field: 'playerColor',
      verified: true,
      // verification: chess_utils.js getBoardElement() uses
      // document.querySelector("wc-chess-board"); the flipped-class
      // orientation logic is used by squareToXY ("flipped" ⇒ black at
      // the bottom). Detection assumption: in Chess.com bot games the
      // player sits at the bottom of the board.
      selectors: Object.freeze(['wc-chess-board']),
      note: 'Board orientation: not flipped ⇒ white, flipped ⇒ black. ' +
        'Board absent ⇒ {value:null, source:\'observed\'} (detection ' +
        'attempted, found nothing).'
    }),
    Object.freeze({
      field: 'botName',
      verified: false,
      selectors: Object.freeze([]),
      note: 'Manual-only (deferred): no verified in-game selector exists ' +
        'in the repo. The public /play/computer picker shows names exist, ' +
        'but no in-game player-tag selector has been verified; inventing ' +
        'one would risk matching the wrong element (the 3.3.4 precedent). ' +
        'A V3 probe populates this entry.'
    }),
    Object.freeze({
      field: 'botDisplayedRating',
      verified: false,
      selectors: Object.freeze([]),
      note: 'Manual-only (deferred): same as botName — no verified ' +
        'in-game selector. A V3 probe populates this entry.'
    }),
    Object.freeze({
      field: 'timeControl',
      verified: false,
      selectors: Object.freeze([]),
      note: 'Manual-only (deferred): no verified selector; the setup-panel ' +
        'control is not probed. A V3 probe populates this entry.'
    }),
    Object.freeze({
      field: 'assistanceSettings',
      verified: false,
      selectors: Object.freeze([]),
      note: 'Manual-only (by design): 3.3.4 explicitly marks Chess.com ' +
        'hints/assistance-setting changes as unsupported coverage ("zero ' +
        'references to hints, assistance settings, or engine-evaluation ' +
        'DOM in product code"); the 1.2 contract states the key inventory ' +
        'comes from the §3.3 DOM audit, which found none. No detection is ' +
        'attempted, ever, in 5.4.'
    })
  ]);

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isDocumentLike(doc) {
    return isPlainObject(doc) && typeof doc.querySelector === 'function';
  }

  function frozenWrapper(value, source) {
    return Object.freeze({ value: value, source: source });
  }

  function manualNull() {
    return frozenWrapper(null, 'manual');
  }

  // detectPlayerColor(doc) → frozen {value, source}. Guarded per-probe:
  // DOM weirdness ⇒ {value:null, source:'observed'} (attempted, found
  // nothing); never throws.
  function detectPlayerColor(doc) {
    try {
      var board = doc.querySelector('wc-chess-board');
      if (board === null || board === undefined) {
        return frozenWrapper(null, 'observed');
      }
      var flipped = false;
      if (board.classList && typeof board.classList.contains === 'function') {
        flipped = !!board.classList.contains('flipped');
      }
      return frozenWrapper(flipped ? 'black' : 'white', 'observed');
    } catch (e) {
      return frozenWrapper(null, 'observed');
    }
  }

  // detectGameConditions(document) → frozen five-field record of
  // {value, source} wrappers. Each probe is individually guarded; a probe
  // failure never propagates. Non-document argument ⇒ TypeError
  // (AGENTS.md convention).
  function detectGameConditions(doc) {
    if (!isDocumentLike(doc)) {
      throw new TypeError('detectGameConditions requires a document');
    }
    return Object.freeze({
      botName: manualNull(),
      botDisplayedRating: manualNull(),
      playerColor: detectPlayerColor(doc),
      timeControl: manualNull(),
      assistanceSettings: manualNull()
    });
  }

  // --- assistanceSettings value parsing (contract §3, strict) ---
  //
  // 'true' → true, 'false' → false, finite numeric string → number,
  // otherwise the trimmed string; empty ⇒ null (the 1.2 "known setting
  // with an unreadable value" case). "null"/"undefined"/"NaN"/"Infinity"
  // stay strings (the 1.2 "no sentinel" rule). A row with a blank name is
  // ignored (not a pair).
  function parseAssistanceValue(raw) {
    if (raw === null || raw === undefined) return null;
    var t = String(raw).trim();
    if (t === '') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    var n = Number(t);
    if (t !== '' && Number.isFinite(n)) return n;
    return t;
  }

  // botDisplayedRating: /^\d+$/ ⇒ Number (the 1.2 normalizer requires a
  // number — passing a valid numeric string through would abort an honest
  // Start; this is type normalization of valid input, not the forbidden
  // silent null-coercion). Anything else passes through un-coerced so the
  // 1.2 normalizer throws → honest Start abort.
  var RATING_RE = /^\d+$/;
  function parseRating(raw) {
    if (raw === null || raw === undefined) return null;
    var t = String(raw).trim();
    if (t === '') return null;
    if (RATING_RE.test(t)) return Number(t);
    return raw;
  }

  function validateOptions(options) {
    if (!isPlainObject(options)) {
      throw new TypeError('options must be an object');
    }
    var beforeElement = options.beforeElement === undefined ?
      null : options.beforeElement;
    if (beforeElement !== null && !isPlainObject(beforeElement)) {
      throw new TypeError('options.beforeElement must be a DOM element or null');
    }
    return { beforeElement: beforeElement };
  }

  // installConditionsPanel(options) → panel handle
  // {element, getDetectedConditions, setEnabled, showAdopted}.
  //
  // Renders the five per-field rows adjacent to 5.2's fields (DOM order:
  // fields → panel → Start → lights). Each row shows a live source tag:
  // 'observed', 'manual', or 'not set'. Manual overrides merge with a
  // FRESH detectGameConditions(document) at Start: manual-dirty wins over
  // detection; cleared-to-blank falls back to detection.
  //
  // The plug-in never throws for invalid manual input and never coerces
  // it to null: invalid values pass through un-coerced; the 1.2
  // normalizers are the backstop (honest Start abort). install throws
  // TypeError on invalid options before any timer/DOM side effect beyond
  // the documented placement; event handlers never throw into page code.
  function installConditionsPanel(options) {
    var opts = validateOptions(options);

    var doc = (typeof document !== 'undefined') ? document : null;
    if (doc === null || typeof doc.createElement !== 'function') {
      throw new Error('conditions panel requires a document');
    }

    var panel = doc.createElement('div');
    panel.className = 'blindfold-conditions-panel';

    var enabled = true;
    var adopted = false;

    // Manual-override state. dirty[field] ⇒ the user supplied a value;
    // cleared-to-blank ⇒ not dirty ⇒ falls back to detection.
    var manual = {
      botName: { dirty: false, value: null },
      botDisplayedRating: { dirty: false, value: null },
      playerColor: { dirty: false, value: null },
      timeControl: { dirty: false, value: null },
      assistanceSettings: { dirty: false, value: null }
    };

    function el(tag, className, text) {
      var n = doc.createElement(tag);
      if (className) n.className = className;
      if (text !== undefined && text !== null) n.textContent = text;
      return n;
    }

    function tagEl() {
      var s = el('span', 'blindfold-conditions-tag', 'not set');
      return s;
    }

    function setTag(tagNode, source) {
      tagNode.textContent = source;
      tagNode.setAttribute('data-source', source);
    }

    // --- playerColor row: detected read-only, or manual select on failure.
    var colorRow = el('div', 'blindfold-conditions-row');
    colorRow.appendChild(el('label', 'blindfold-conditions-label', 'Side'));
    var colorTag = tagEl();
    var colorSelect = null;
    var colorReadonly = null;
    var installDetection = detectPlayerColor(doc);
    if (installDetection.value === 'white' || installDetection.value === 'black') {
      // Successful detection: read-only (PLAN: manual completion is for
      // *unavailable* fields; a wrong detection is a V3 refinement).
      colorReadonly = el('span', 'blindfold-conditions-detected',
        installDetection.value === 'white' ? 'White' : 'Black');
      colorReadonly.setAttribute('data-detected-color', installDetection.value);
      colorRow.appendChild(colorReadonly);
      setTag(colorTag, 'observed');
    } else {
      // Detection failure: manual completion via White/Black select.
      colorSelect = doc.createElement('select');
      colorSelect.className = 'blindfold-conditions-color';
      colorSelect.setAttribute('aria-label', 'Your side (manual)');
      var ph = doc.createElement('option');
      ph.value = '';
      ph.textContent = 'Select…';
      colorSelect.appendChild(ph);
      var whiteOpt = doc.createElement('option');
      whiteOpt.value = 'white';
      whiteOpt.textContent = 'White';
      colorSelect.appendChild(whiteOpt);
      var blackOpt = doc.createElement('option');
      blackOpt.value = 'black';
      blackOpt.textContent = 'Black';
      colorSelect.appendChild(blackOpt);
      colorRow.appendChild(colorSelect);
      setTag(colorTag, 'not set');
      colorSelect.addEventListener('change', function () {
        try {
          if (!enabled) return;
          var v = colorSelect.value;
          manual.playerColor.dirty = (v === 'white' || v === 'black');
          manual.playerColor.value = manual.playerColor.dirty ? v : null;
          setTag(colorTag, manual.playerColor.dirty ? 'manual' : 'not set');
        } catch (e) { /* never throw into page code */ }
      });
    }
    // Re-detect button: a manual refresh affordance (not a status).
    var redetectBtn = el('button', 'blindfold-conditions-redetect', 'Re-detect');
    redetectBtn.type = 'button';
    redetectBtn.setAttribute('aria-label', 'Re-detect game conditions');
    redetectBtn.title = 'Re-run board detection';
    colorRow.appendChild(redetectBtn);
    colorRow.appendChild(colorTag);
    panel.appendChild(colorRow);

    redetectBtn.addEventListener('click', function () {
      try {
        if (!enabled) return;
        var fresh = detectPlayerColor(doc);
        if (fresh.value === 'white' || fresh.value === 'black') {
          // Replace the row's control with the fresh read-only value.
          if (colorSelect !== null && colorSelect.parentNode === colorRow) {
            colorRow.removeChild(colorSelect);
            colorSelect = null;
          }
          if (colorReadonly === null) {
            colorReadonly = el('span', 'blindfold-conditions-detected', '');
            colorRow.insertBefore(colorReadonly, redetectBtn);
          }
          colorReadonly.textContent =
            fresh.value === 'white' ? 'White' : 'Black';
          colorReadonly.setAttribute('data-detected-color', fresh.value);
          manual.playerColor.dirty = false;
          manual.playerColor.value = null;
          setTag(colorTag, 'observed');
        } else {
          // Still failing: ensure the manual select exists.
          if (colorSelect === null) {
            if (colorReadonly !== null && colorReadonly.parentNode === colorRow) {
              colorRow.removeChild(colorReadonly);
              colorReadonly = null;
            }
            colorSelect = doc.createElement('select');
            colorSelect.className = 'blindfold-conditions-color';
            colorSelect.setAttribute('aria-label', 'Your side (manual)');
            var ph2 = doc.createElement('option');
            ph2.value = '';
            ph2.textContent = 'Select…';
            colorSelect.appendChild(ph2);
            var w2 = doc.createElement('option');
            w2.value = 'white';
            w2.textContent = 'White';
            colorSelect.appendChild(w2);
            var b2 = doc.createElement('option');
            b2.value = 'black';
            b2.textContent = 'Black';
            colorSelect.appendChild(b2);
            colorSelect.disabled = !enabled;
            colorSelect.addEventListener('change', function () {
              try {
                if (!enabled) return;
                var v = colorSelect.value;
                manual.playerColor.dirty = (v === 'white' || v === 'black');
                manual.playerColor.value = manual.playerColor.dirty ? v : null;
                setTag(colorTag, manual.playerColor.dirty ? 'manual' : 'not set');
              } catch (e) { /* never throw into page code */ }
            });
            colorRow.insertBefore(colorSelect, redetectBtn);
          }
          setTag(colorTag, manual.playerColor.dirty ? 'manual' : 'not set');
        }
      } catch (e) { /* never throw into page code */ }
    });

    // --- text rows: botName, botDisplayedRating, timeControl.
    function makeTextRow(field, label, placeholder, liveValidate) {
      var row = el('div', 'blindfold-conditions-row');
      row.appendChild(el('label', 'blindfold-conditions-label', label));
      var input = doc.createElement('input');
      input.type = 'text';
      input.className = 'blindfold-conditions-' + field;
      input.setAttribute('aria-label', label);
      if (placeholder) input.setAttribute('placeholder', placeholder);
      row.appendChild(input);
      var tag = tagEl();
      row.appendChild(tag);
      var err = el('span', 'blindfold-conditions-error', '');
      err.setAttribute('role', 'alert');
      err.style.display = 'none';
      row.appendChild(err);
      panel.appendChild(row);
      input.addEventListener('input', function () {
        try {
          if (!enabled) return;
          var raw = input.value;
          var t = (typeof raw === 'string') ? raw.trim() : '';
          manual[field].dirty = (t !== '');
          manual[field].value = raw;
          var valid = true;
          if (liveValidate && t !== '') {
            valid = liveValidate(t);
          }
          if (!valid) {
            err.textContent = 'Expected a non-negative integer (e.g. 250).';
            err.style.display = '';
          } else {
            err.textContent = '';
            err.style.display = 'none';
          }
          setTag(tag, manual[field].dirty ? 'manual' : 'not set');
        } catch (e) { /* never throw into page code */ }
      });
      return { row: row, input: input, tag: tag, err: err };
    }

    var nameRow = makeTextRow('botName', 'Bot', 'Bot name', null);
    var ratingRow = makeTextRow('botDisplayedRating', 'Rating',
      'Displayed rating', function (t) { return RATING_RE.test(t); });
    var timeRow = makeTextRow('timeControl', 'Time', 'Time control', null);

    // --- assistanceSettings row editor.
    var asRow = el('div', 'blindfold-conditions-row');
    asRow.appendChild(el('label', 'blindfold-conditions-label', 'Assistance'));
    var asList = el('div', 'blindfold-conditions-pairs');
    asRow.appendChild(asList);
    var asTag = tagEl();
    asRow.appendChild(asTag);
    panel.appendChild(asRow);

    function refreshPairsDirty() {
      var pairs = collectPairs();
      manual.assistanceSettings.dirty = pairs.length > 0;
      manual.assistanceSettings.value = pairs;
      setTag(asTag, pairs.length > 0 ? 'manual' : 'not set');
    }

    function collectPairs() {
      var out = [];
      var rows = asList.children;
      for (var i = 0; i < rows.length; i++) {
        var nameInput = rows[i].querySelector('.blindfold-conditions-pair-name');
        var valueInput = rows[i].querySelector('.blindfold-conditions-pair-value');
        if (!nameInput || !valueInput) continue;
        var name = (typeof nameInput.value === 'string') ?
          nameInput.value.trim() : '';
        if (name === '') continue;
        out.push({ name: name, value: parseAssistanceValue(valueInput.value) });
      }
      return out;
    }

    function addPairRow() {
      var prow = el('div', 'blindfold-conditions-pair');
      var nameInput = doc.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'blindfold-conditions-pair-name';
      nameInput.setAttribute('aria-label', 'Assistance setting name');
      nameInput.setAttribute('placeholder', 'Setting');
      var valueInput = doc.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'blindfold-conditions-pair-value';
      valueInput.setAttribute('aria-label', 'Assistance setting value');
      valueInput.setAttribute('placeholder', 'Value');
      var removeBtn = el('button', 'blindfold-conditions-pair-remove', '✕');
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', 'Remove assistance setting row');
      prow.appendChild(nameInput);
      prow.appendChild(valueInput);
      prow.appendChild(removeBtn);
      asList.appendChild(prow);
      var onEdit = function () {
        try {
          if (!enabled) return;
          // An empty trailing row is always present so filling it adds
          // a pair (no separate Add button): when the last row gains a
          // name, append a fresh empty row.
          var last = asList.lastChild;
          if (last) {
            var lastName = last.querySelector('.blindfold-conditions-pair-name');
            if (lastName && typeof lastName.value === 'string' &&
                lastName.value.trim() !== '') {
              addPairRow();
              refreshRemoveButtons();
            }
          }
          refreshPairsDirty();
        } catch (e) { /* never throw into page code */ }
      };
      nameInput.addEventListener('input', onEdit);
      valueInput.addEventListener('input', onEdit);
      removeBtn.addEventListener('click', function () {
        try {
          if (!enabled) return;
          if (prow.parentNode === asList) asList.removeChild(prow);
          if (asList.children.length === 0) addPairRow();
          refreshRemoveButtons();
          refreshPairsDirty();
        } catch (e) { /* never throw into page code */ }
      });
      return prow;
    }

    function refreshRemoveButtons() {
      var rows = asList.children;
      for (var i = 0; i < rows.length; i++) {
        var btn = rows[i].querySelector('.blindfold-conditions-pair-remove');
        if (btn) btn.disabled = !enabled;
      }
    }

    addPairRow();

    // --- placement: immediately before 5.1's control cluster when the
    // caller provides it (DOM order: fields → panel → Start → lights);
    // the 2.8 fixed-corner fallback otherwise.
    if (opts.beforeElement && opts.beforeElement.parentNode) {
      opts.beforeElement.parentNode.insertBefore(panel, opts.beforeElement);
    } else {
      var anchor = doc.getElementById('blindfold-chess-move-input');
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(panel, anchor.nextSibling);
      } else {
        panel.className += ' blindfold-conditions-panel-fallback';
        doc.body.appendChild(panel);
      }
    }

    function setEnabled(on) {
      enabled = !!on;
      var disabled = !enabled;
      var inputs = panel.querySelectorAll('input, select, button');
      for (var i = 0; i < inputs.length; i++) {
        inputs[i].disabled = disabled;
      }
    }

    function showAdopted() {
      // The panel disables and shows the adopted note. Install-time
      // detected values stay visible but are labeled as current-page
      // detection — never as the adopted session's record (the adopted
      // conditions live in IDB, unreachable from the content script).
      adopted = true;
      setEnabled(false);
      var note = panel.querySelector('.blindfold-conditions-adopted-note');
      if (!note) {
        note = el('div', 'blindfold-conditions-adopted-note',
          'Session adopted after reload — conditions were recorded at ' +
          'its start. Values shown are current-page detection, not the ' +
          'adopted session\u2019s record.');
        panel.insertBefore(note, panel.firstChild);
      }
    }

    // getDetectedConditions — the 5.2 plug-in. Fresh
    // detectGameConditions(document) merged with manual overrides:
    // manual-dirty ⇒ {manualValue,'manual'} (manual wins over fresh
    // detection); else ⇒ fresh detection result. Cleared-to-blank is not
    // dirty ⇒ falls back to detection. Never throws for invalid manual
    // input and never coerces it to null — invalid values pass through
    // un-coerced; the 1.2 normalizers are the backstop (honest Start
    // abort via record-build-failed).
    function getDetectedConditions() {
      var fresh = detectGameConditions(doc);
      var out = {};
      var i, field;
      for (i = 0; i < DETECTED_FIELD_NAMES.length; i++) {
        field = DETECTED_FIELD_NAMES[i];
        if (manual[field].dirty) {
          out[field] = frozenWrapper(manualValue(field), 'manual');
        } else {
          out[field] = fresh[field];
        }
      }
      return Object.freeze(out);
    }

    function manualValue(field) {
      if (field === 'botDisplayedRating') {
        return parseRating(manual[field].value);
      }
      if (field === 'assistanceSettings') {
        var pairs = collectPairs();
        var obj = {};
        for (var i = 0; i < pairs.length; i++) {
          obj[pairs[i].name] = pairs[i].value;
        }
        return obj;
      }
      return manual[field].value;
    }

    return {
      element: panel,
      getDetectedConditions: getDetectedConditions,
      setEnabled: setEnabled,
      showAdopted: showAdopted
    };
  }

  // attachConditionsPanel(fieldsHandle, panelHandle) → composite handle.
  // Preserves the isFieldsHandle shape ({getSelection, setSelection,
  // setEnabled, getDetectedConditions} + showAdoptedCategory) so
  // session_controls.js stays byte-identical: setEnabled drives both
  // forms (each in try/catch); showAdoptedCategory drives the fields'
  // version plus panelHandle.showAdopted(); getDetectedConditions
  // delegates to the fields handle's (which already wraps the panel
  // plug-in with the UNDETECTED_CONDITION_FIELDS fallback).
  function isFieldsHandleLike(h) {
    return isPlainObject(h) &&
      typeof h.getSelection === 'function' &&
      typeof h.setSelection === 'function' &&
      typeof h.setEnabled === 'function' &&
      typeof h.getDetectedConditions === 'function';
  }

  function isPanelHandle(h) {
    return isPlainObject(h) &&
      typeof h.getDetectedConditions === 'function' &&
      typeof h.setEnabled === 'function' &&
      typeof h.showAdopted === 'function';
  }

  function attachConditionsPanel(fieldsHandle, panelHandle) {
    if (!isFieldsHandleLike(fieldsHandle)) {
      throw new TypeError('attachConditionsPanel requires a fields handle');
    }
    if (!isPanelHandle(panelHandle)) {
      throw new TypeError('attachConditionsPanel requires a panel handle');
    }
    function setEnabled(on) {
      try { fieldsHandle.setEnabled(on); } catch (e) { /* best-effort */ }
      try { panelHandle.setEnabled(on); } catch (e) { /* best-effort */ }
    }
    function showAdoptedCategory(category) {
      if (typeof fieldsHandle.showAdoptedCategory === 'function') {
        try { fieldsHandle.showAdoptedCategory(category); } catch (e) { /* best-effort */ }
      }
      try { panelHandle.showAdopted(); } catch (e) { /* best-effort */ }
    }
    var composite = {
      getSelection: function () { return fieldsHandle.getSelection(); },
      setSelection: function (sel) { return fieldsHandle.setSelection(sel); },
      setEnabled: setEnabled,
      getDetectedConditions: function () {
        return fieldsHandle.getDetectedConditions();
      }
    };
    if (typeof fieldsHandle.showAdoptedCategory === 'function') {
      composite.showAdoptedCategory = showAdoptedCategory;
    }
    if (hasOwn(fieldsHandle, 'element')) {
      composite.element = fieldsHandle.element;
    }
    if (typeof fieldsHandle.getExtensionVersion === 'function') {
      composite.getExtensionVersion = function () {
        return fieldsHandle.getExtensionVersion();
      };
    }
    return composite;
  }

  BlindfoldSession.DETECTED_FIELD_NAMES_54 = DETECTED_FIELD_NAMES;
  BlindfoldSession.CONDITION_PROBES = CONDITION_PROBES;
  BlindfoldSession.detectGameConditions = detectGameConditions;
  BlindfoldSession.parseAssistanceValue = parseAssistanceValue;
  BlindfoldSession.parseRating = parseRating;
  BlindfoldSession.installConditionsPanel = installConditionsPanel;
  BlindfoldSession.attachConditionsPanel = attachConditionsPanel;
})();

// Node test shim. Content-script consumers use the BlindfoldSession global
// directly; only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
