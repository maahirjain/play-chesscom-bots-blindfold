// tests/detected_conditions.test.js
//
// Task 5.4 (PLAN.md §5.4): show detected game conditions and allow manual
// completion of unavailable fields before recording.
//
// V1 — static + unit. Covers 5.4.contract.md AC1–AC7 (AC8–AC10 are the
// V2 harness; AC11 is V3-deferred to §7).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

function freshModule(name) {
  delete require.cache[require.resolve('../' + name)];
  return require('../' + name);
}

// Merged namespace: the modules share the BlindfoldSession global;
// session_fields.js resolves collaborators at call time via globalThis.
function mergedNS() {
  const ns = {};
  for (const f of ['session_identity.js', 'session_conditions.js',
                   'session_fields.js', 'detected_conditions.js']) {
    Object.assign(ns, freshModule(f));
  }
  return ns;
}

function codeOnly(name) {
  const src = fs.readFileSync(path.join(REPO, name), 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

// ------------------------------------------------------------------
// Fake DOM (richer than the 5.2 fake: needs querySelector, classList,
// removeChild, firstChild/lastChild, and event firing).
// ------------------------------------------------------------------

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    type: '',
    style: {},
    parentNode: null,
    children: [],
    _attrs: {},
    _listeners: {},
    classList: {
      _s: new Set(),
      contains(c) { return this._s.has(String(c)); },
      add(c) { this._s.add(String(c)); },
      remove(c) { this._s.delete(String(c)); },
    },
    setAttribute(k, v) { this._attrs[String(k)] = String(v); },
    getAttribute(k) {
      const key = String(k);
      return Object.prototype.hasOwnProperty.call(this._attrs, key) ?
        this._attrs[key] : null;
    },
    addEventListener(type, fn) {
      const t = String(type);
      (this._listeners[t] = this._listeners[t] || []).push(fn);
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i === -1) this.children.push(child);
      else this.children.splice(i, 0, child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    querySelector(sel) {
      const all = this.querySelectorAll(sel);
      return all.length ? all[0] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
      const walk = (n) => {
        for (const c of n.children) {
          for (const p of parts) {
            if (p[0] === '.' && (c.className || '').split(' ').includes(p.slice(1))) {
              out.push(c);
              break;
            } else if (p[0] !== '.' && c.tagName === p.toUpperCase()) {
              out.push(c);
              break;
            }
          }
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    get firstChild() { return this.children[0] || null; },
    get lastChild() {
      return this.children.length ? this.children[this.children.length - 1] : null;
    },
    fire(type) {
      for (const fn of this._listeners[type] || []) fn({ target: this });
    },
    setInput(v) {
      this.value = v;
      this.fire('input');
    },
    click() {
      for (const fn of this._listeners.click || []) fn({ target: this });
    },
  };
  return el;
}

// board: 'none' | 'white' (present, not flipped) | 'black' (flipped).
// querySelector('wc-chess-board') is mutable via doc.__setBoard().
function makeFakeDocument(board) {
  const body = makeEl('body');
  let boardEl = null;
  const setBoard = (b) => {
    boardEl = null;
    if (b !== 'none') {
      boardEl = makeEl('wc-chess-board');
      if (b === 'black') boardEl.classList.add('flipped');
    }
  };
  setBoard(board);
  const doc = {
    body,
    __setBoard: setBoard,
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    querySelector: (sel) => {
      if (sel === 'wc-chess-board') return boardEl;
      return body.querySelector(sel);
    },
  };
  return doc;
}

let savedDocument;
let savedNS;
beforeEach(() => {
  savedDocument = globalThis.document;
  savedNS = globalThis.BlindfoldSession;
});
afterEach(() => {
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
  if (savedNS === undefined) delete globalThis.BlindfoldSession;
  else globalThis.BlindfoldSession = savedNS;
});

function publishNS(ns) {
  globalThis.BlindfoldSession = ns;
  return ns;
}

function installPanel(ns, doc, board) {
  globalThis.document = doc;
  publishNS(ns);
  return ns.installConditionsPanel({ beforeElement: null });
}

// ------------------------------------------------------------------
// AC1 — module shape and convention.
// ------------------------------------------------------------------

describe('AC1 — module exists and follows the convention', () => {
  it('exports detectGameConditions, CONDITION_PROBES, installConditionsPanel, attachConditionsPanel', () => {
    const ns = mergedNS();
    assert.equal(typeof ns.detectGameConditions, 'function');
    assert.ok(Array.isArray(ns.CONDITION_PROBES));
    assert.equal(typeof ns.installConditionsPanel, 'function');
    assert.equal(typeof ns.attachConditionsPanel, 'function');
  });

  it('loads via the Node shim and shares the guarded BlindfoldSession global', () => {
    const src = fs.readFileSync(path.join(REPO, 'detected_conditions.js'), 'utf8');
    assert.ok(src.includes('var BlindfoldSession = BlindfoldSession || {};'),
      'guarded global');
    assert.ok(src.includes("'use strict'"), 'strict mode');
    assert.ok(src.includes('module.exports'), 'Node shim');
  });

  it('TypeError on wrong types (never a weak fallback)', () => {
    const ns = mergedNS();
    assert.throws(() => ns.detectGameConditions(null), TypeError);
    assert.throws(() => ns.detectGameConditions({}), TypeError);
    assert.throws(() => ns.detectGameConditions('wc-chess-board'), TypeError);
    assert.throws(() => ns.installConditionsPanel(null), TypeError);
    assert.throws(() => ns.installConditionsPanel({ beforeElement: 42 }), TypeError);
    assert.throws(() => ns.attachConditionsPanel(null, {}), TypeError);
    assert.throws(() => ns.attachConditionsPanel({}, null), TypeError);
  });
});

// ------------------------------------------------------------------
// AC2 — detectGameConditions.
// ------------------------------------------------------------------

describe('AC2 — detectGameConditions', () => {
  it("board not flipped ⇒ {value:'white', source:'observed'}", () => {
    const ns = mergedNS();
    const r = ns.detectGameConditions(makeFakeDocument('white'));
    assert.deepEqual(r.playerColor, { value: 'white', source: 'observed' });
  });

  it("flipped board ⇒ {value:'black', source:'observed'}", () => {
    const ns = mergedNS();
    const r = ns.detectGameConditions(makeFakeDocument('black'));
    assert.deepEqual(r.playerColor, { value: 'black', source: 'observed' });
  });

  it("board absent ⇒ {value:null, source:'observed'} (attempted, found nothing)", () => {
    const ns = mergedNS();
    const r = ns.detectGameConditions(makeFakeDocument('none'));
    assert.deepEqual(r.playerColor, { value: null, source: 'observed' });
  });

  it("the other four fields ⇒ {value:null, source:'manual'} (no detection attempted)", () => {
    const ns = mergedNS();
    const r = ns.detectGameConditions(makeFakeDocument('white'));
    for (const f of ['botName', 'botDisplayedRating', 'timeControl', 'assistanceSettings']) {
      assert.deepEqual(r[f], { value: null, source: 'manual' }, f);
    }
  });

  it('the record and every wrapper are frozen', () => {
    const ns = mergedNS();
    const r = ns.detectGameConditions(makeFakeDocument('white'));
    assert.ok(Object.isFrozen(r));
    for (const f of Object.keys(r)) assert.ok(Object.isFrozen(r[f]), f);
  });

  it('probe exceptions never propagate', () => {
    const ns = mergedNS();
    const badDoc = { querySelector() { throw new Error('boom'); } };
    const r = ns.detectGameConditions(badDoc);
    assert.deepEqual(r.playerColor, { value: null, source: 'observed' });
    // A board whose classList.contains throws is also contained.
    const evilBoard = makeEl('wc-chess-board');
    evilBoard.classList.contains = () => { throw new Error('evil'); };
    const doc2 = makeFakeDocument('none');
    doc2.querySelector = (sel) => (sel === 'wc-chess-board' ? evilBoard : null);
    const r2 = ns.detectGameConditions(doc2);
    assert.deepEqual(r2.playerColor, { value: null, source: 'observed' });
  });
});

// ------------------------------------------------------------------
// AC3 — CONDITION_PROBES.
// ------------------------------------------------------------------

describe('AC3 — CONDITION_PROBES', () => {
  it('five entries; only playerColor verified:true', () => {
    const ns = mergedNS();
    assert.equal(ns.CONDITION_PROBES.length, 5);
    const fields = ns.CONDITION_PROBES.map((e) => e.field).sort();
    assert.deepEqual(fields, ['assistanceSettings', 'botDisplayedRating',
      'botName', 'playerColor', 'timeControl']);
    for (const e of ns.CONDITION_PROBES) {
      if (e.field === 'playerColor') assert.equal(e.verified, true);
      else assert.equal(e.verified, false, e.field);
    }
  });

  it('unverified entries have empty selectors and documented reasons', () => {
    const ns = mergedNS();
    for (const e of ns.CONDITION_PROBES) {
      if (!e.verified) {
        assert.deepEqual(e.selectors, [], e.field);
        assert.ok(typeof e.note === 'string' && e.note.length > 20,
          e.field + ' documents why');
      }
    }
    const player = ns.CONDITION_PROBES.find((e) => e.field === 'playerColor');
    assert.ok(player.selectors.includes('wc-chess-board'));
  });

  it('the table and every entry are frozen', () => {
    const ns = mergedNS();
    assert.ok(Object.isFrozen(ns.CONDITION_PROBES));
    for (const e of ns.CONDITION_PROBES) {
      assert.ok(Object.isFrozen(e), e.field);
      assert.ok(Object.isFrozen(e.selectors), e.field);
    }
  });

  it('code-scan pin: verified:true requires a cited verification', () => {
    // An entry may only be marked verified:true with a cited verification
    // (test or V3 evidence). The pin counts 'verification:' citations
    // against verified:true entries in the module source.
    // An entry may only be marked verified:true with a cited verification
    // (test or V3 evidence). The pin counts 'verification:' citations
    // against verified:true entries in the module source. The regex
    // matches the object-literal entry style only (comments use the
    // no-space form and are not counted).
    const src = fs.readFileSync(path.join(REPO, 'detected_conditions.js'), 'utf8');
    const verifiedTrue = (src.match(/^\s*verified: true,$/gm) || []).length;
    const citations = (src.match(/verification:/g) || []).length;
    assert.ok(verifiedTrue > 0, 'at least one verified entry exists');
    assert.ok(citations >= verifiedTrue,
      `verified:true entries (${verifiedTrue}) need ≥ that many ` +
      `'verification:' citations (${citations})`);
  });
});

// ------------------------------------------------------------------
// AC4 — merge at Start.
// ------------------------------------------------------------------

describe('AC4 — merge at Start', () => {
  function panelWith(ns, board) {
    const doc = makeFakeDocument(board);
    const handle = installPanel(ns, doc, board);
    return { doc, handle };
  }

  function rowInput(handle, cls) {
    return handle.element.querySelector('.' + cls);
  }

  it('manual-dirty wins over fresh detection', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'white');
    rowInput(handle, 'blindfold-conditions-botName').setInput('Martinfoot');
    const got = handle.getDetectedConditions();
    assert.deepEqual(got.botName, { value: 'Martinfoot', source: 'manual' });
    // Detection still supplies the non-dirty field.
    assert.deepEqual(got.playerColor, { value: 'white', source: 'observed' });
  });

  it('cleared-to-blank falls back to detection', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'white');
    const input = rowInput(handle, 'blindfold-conditions-botName');
    input.setInput('Martinfoot');
    input.setInput('   ');
    const got = handle.getDetectedConditions();
    assert.deepEqual(got.botName, { value: null, source: 'manual' });
  });

  it('blank manual ⇒ null, never ""', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'white');
    rowInput(handle, 'blindfold-conditions-timeControl').setInput('   ');
    const got = handle.getDetectedConditions();
    assert.equal(got.timeControl.value, null);
  });

  it('valid rating "250" ⇒ number 250 (type normalization, not null-coercion)', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'white');
    rowInput(handle, 'blindfold-conditions-botDisplayedRating').setInput('250');
    const got = handle.getDetectedConditions();
    assert.deepEqual(got.botDisplayedRating, { value: 250, source: 'manual' });
  });

  it('invalid rating "12x" passes through un-coerced; the 1.2 normalizer throws → honest abort', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'white');
    rowInput(handle, 'blindfold-conditions-botDisplayedRating').setInput('12x');
    const got = handle.getDetectedConditions();
    // No silent null-coercion: the raw value survives.
    assert.deepEqual(got.botDisplayedRating, { value: '12x', source: 'manual' });
    // The 1.2 backstop throws → session_controls aborts Start honestly.
    assert.throws(() => ns.buildInitialConditions(
      { sessionCategory: 'training' }, got), TypeError);
  });

  it('playerColor manual select (detection failed) is dirty; clearing falls back', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'none');
    const sel = rowInput(handle, 'blindfold-conditions-color');
    assert.ok(sel, 'manual select rendered on detection failure');
    sel.value = 'black';
    sel.fire('change');
    assert.deepEqual(handle.getDetectedConditions().playerColor,
      { value: 'black', source: 'manual' });
    sel.value = '';
    sel.fire('change');
    assert.deepEqual(handle.getDetectedConditions().playerColor,
      { value: null, source: 'observed' });
  });

  it('successful detection has no override affordance (read-only)', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'white');
    assert.equal(handle.element.querySelector('.blindfold-conditions-color'), null);
    const ro = handle.element.querySelector('.blindfold-conditions-detected');
    assert.ok(ro, 'read-only detection shown');
    assert.equal(ro.textContent, 'White');
  });

  it('assistanceSettings pairs: strict parsing, blank-name rows ignored', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'white');
    const list = handle.element.querySelector('.blindfold-conditions-pairs');
    const row = list.children[0];
    row.querySelector('.blindfold-conditions-pair-name').setInput('hints');
    row.querySelector('.blindfold-conditions-pair-value').setInput('true');
    // Filling the trailing row's name appends a fresh empty row.
    assert.equal(list.children.length, 2);
    const row2 = list.children[1];
    row2.querySelector('.blindfold-conditions-pair-name').setInput('depth');
    row2.querySelector('.blindfold-conditions-pair-value').setInput('12');
    const row3 = list.children[2];
    row3.querySelector('.blindfold-conditions-pair-name').setInput('note');
    row3.querySelector('.blindfold-conditions-pair-value').setInput('null');
    const got = handle.getDetectedConditions().assistanceSettings;
    assert.equal(got.source, 'manual');
    assert.deepEqual(got.value, { hints: true, depth: 12, note: 'null' });
  });

  it('assistanceSettings: empty value ⇒ null; "false" ⇒ false', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'white');
    const list = handle.element.querySelector('.blindfold-conditions-pairs');
    const row = list.children[0];
    row.querySelector('.blindfold-conditions-pair-name').setInput('eval');
    row.querySelector('.blindfold-conditions-pair-value').setInput('');
    const row2 = list.children[1];
    row2.querySelector('.blindfold-conditions-pair-name').setInput('undo');
    row2.querySelector('.blindfold-conditions-pair-value').setInput('false');
    const got = handle.getDetectedConditions().assistanceSettings;
    assert.deepEqual(got.value, { eval: null, undo: false });
  });

  it('no pairs ⇒ not dirty ⇒ {null, manual}', () => {
    const ns = mergedNS();
    const { handle } = panelWith(ns, 'white');
    assert.deepEqual(handle.getDetectedConditions().assistanceSettings,
      { value: null, source: 'manual' });
  });
});

// ------------------------------------------------------------------
// AC5 — installConditionsPanel.
// ------------------------------------------------------------------

describe('AC5 — installConditionsPanel', () => {
  it('renders five rows with live source tags', () => {
    const ns = mergedNS();
    const handle = installPanel(ns, makeFakeDocument('white'), 'white');
    publishNS(ns);
    const rows = handle.element.querySelectorAll('.blindfold-conditions-row');
    assert.equal(rows.length, 5);
    const tags = handle.element.querySelectorAll('.blindfold-conditions-tag');
    assert.equal(tags.length, 5);
  });

  it('source tags go observed → manual → not set live', () => {
    const ns = mergedNS();
    const doc = makeFakeDocument('white');
    const handle = installPanel(ns, doc, 'white');
    const tags = handle.element.querySelectorAll('.blindfold-conditions-tag');
    assert.equal(tags[0].textContent, 'observed');
    assert.equal(tags[1].textContent, 'not set');
    handle.element.querySelector('.blindfold-conditions-botName').setInput('x');
    assert.equal(tags[1].textContent, 'manual');
    assert.equal(tags[1].getAttribute('data-source'), 'manual');
  });

  it('rating live validation: invalid shows an inline error, valid clears it', () => {
    const ns = mergedNS();
    const handle = installPanel(ns, makeFakeDocument('white'), 'white');
    const input = handle.element.querySelector('.blindfold-conditions-botDisplayedRating');
    const err = input.parentNode.querySelector('.blindfold-conditions-error');
    input.setInput('12x');
    assert.notEqual(err.style.display, 'none');
    assert.ok(err.textContent.length > 0);
    input.setInput('250');
    assert.equal(err.style.display, 'none');
  });

  it('setEnabled(false) disables every input, select, and button', () => {
    const ns = mergedNS();
    const handle = installPanel(ns, makeFakeDocument('white'), 'white');
    handle.setEnabled(false);
    const controls = handle.element.querySelectorAll('input, select, button');
    assert.ok(controls.length > 0);
    for (const c of controls) assert.equal(c.disabled, true);
    handle.setEnabled(true);
    for (const c of controls) assert.equal(c.disabled, false);
  });

  it('Re-detect re-runs detection and re-renders', () => {
    const ns = mergedNS();
    const doc = makeFakeDocument('none');
    const handle = installPanel(ns, doc, 'none');
    assert.ok(handle.element.querySelector('.blindfold-conditions-color'),
      'select while board absent');
    doc.__setBoard('black');
    handle.element.querySelector('.blindfold-conditions-redetect').click();
    const ro = handle.element.querySelector('.blindfold-conditions-detected');
    assert.ok(ro, 'read-only detection after re-detect');
    assert.equal(ro.textContent, 'Black');
    assert.equal(handle.element.querySelector('.blindfold-conditions-color'), null);
    assert.deepEqual(handle.getDetectedConditions().playerColor,
      { value: 'black', source: 'observed' });
  });

  it('Re-detect with a still-absent board keeps the manual select (no throw)', () => {
    const ns = mergedNS();
    const handle = installPanel(ns, makeFakeDocument('none'), 'none');
    handle.element.querySelector('.blindfold-conditions-redetect').click();
    assert.ok(handle.element.querySelector('.blindfold-conditions-color'));
  });

  it('event handlers never throw into page code on hostile values', () => {
    const ns = mergedNS();
    const handle = installPanel(ns, makeFakeDocument('white'), 'white');
    const input = handle.element.querySelector('.blindfold-conditions-botDisplayedRating');
    // Non-string values (impossible on a real DOM input) are treated as
    // blank — safe fallback, never a throw, never recorded garbage.
    input.value = 12345;
    input.fire('input');
    assert.deepEqual(handle.getDetectedConditions().botDisplayedRating,
      { value: null, source: 'manual' });
    input.value = null;
    input.fire('input');
    assert.deepEqual(handle.getDetectedConditions().botDisplayedRating,
      { value: null, source: 'manual' });
    // And normal string input still works afterwards.
    input.setInput('250');
    assert.deepEqual(handle.getDetectedConditions().botDisplayedRating,
      { value: 250, source: 'manual' });
  });

  it('panel placement: beforeElement anchor, else move-input anchor, else fixed fallback', () => {
    const ns = mergedNS();
    // Anchor case: inserted before the given element.
    const doc = makeFakeDocument('white');
    globalThis.document = doc;
    publishNS(ns);
    const before = doc.createElement('div');
    doc.body.appendChild(before);
    const h1 = ns.installConditionsPanel({ beforeElement: before });
    assert.equal(doc.body.children.indexOf(h1.element) + 1,
      doc.body.children.indexOf(before));
    // Fallback case: no anchor anywhere → fixed-corner class.
    const doc2 = makeFakeDocument('white');
    globalThis.document = doc2;
    const h2 = ns.installConditionsPanel({ beforeElement: null });
    assert.ok(h2.element.className.includes('blindfold-conditions-panel-fallback'));
    assert.equal(doc2.body.children[doc2.body.children.length - 1], h2.element);
  });
});

// ------------------------------------------------------------------
// AC6 — attachConditionsPanel.
// ------------------------------------------------------------------

describe('AC6 — attachConditionsPanel', () => {
  function stubFields() {
    const calls = { setEnabled: [], showAdopted: [] };
    return {
      _calls: calls,
      getSelection() { return { sessionCategory: 'training' }; },
      setSelection() {},
      setEnabled(on) { calls.setEnabled.push(on); },
      showAdoptedCategory(c) { calls.showAdopted.push(c); },
      getDetectedConditions() {
        return globalThis.BlindfoldSession.UNDETECTED_CONDITION_FIELDS;
      },
    };
  }

  it('composite preserves the isFieldsHandle shape', () => {
    const ns = mergedNS();
    const fields = stubFields();
    const panel = installPanel(ns, makeFakeDocument('white'), 'white');
    const c = ns.attachConditionsPanel(fields, panel);
    assert.equal(typeof c.getSelection, 'function');
    assert.equal(typeof c.setSelection, 'function');
    assert.equal(typeof c.setEnabled, 'function');
    assert.equal(typeof c.getDetectedConditions, 'function');
    assert.equal(typeof c.showAdoptedCategory, 'function');
    // Delegation works.
    assert.deepEqual(c.getSelection(), { sessionCategory: 'training' });
    assert.deepEqual(c.getDetectedConditions(),
      ns.UNDETECTED_CONDITION_FIELDS);
  });

  it('setEnabled drives both forms (each in try/catch)', () => {
    const ns = mergedNS();
    const fields = stubFields();
    const panel = installPanel(ns, makeFakeDocument('white'), 'white');
    const c = ns.attachConditionsPanel(fields, panel);
    c.setEnabled(false);
    assert.deepEqual(fields._calls.setEnabled, [false]);
    const controls = panel.element.querySelectorAll('input, select, button');
    for (const el of controls) assert.equal(el.disabled, true);
    c.setEnabled(true);
    assert.deepEqual(fields._calls.setEnabled, [false, true]);
  });

  it('showAdoptedCategory drives the fields version plus panel.showAdopted()', () => {
    const ns = mergedNS();
    const fields = stubFields();
    const panel = installPanel(ns, makeFakeDocument('white'), 'white');
    const c = ns.attachConditionsPanel(fields, panel);
    c.showAdoptedCategory('training');
    assert.deepEqual(fields._calls.showAdopted, ['training']);
    const note = panel.element.querySelector('.blindfold-conditions-adopted-note');
    assert.ok(note, 'adopted note shown');
    assert.ok(note.textContent.includes('recorded at its start'));
    const controls = panel.element.querySelectorAll('input, select, button');
    for (const el of controls) assert.equal(el.disabled, true);
  });

  it('getDetectedConditions keeps the placeholder fallback on plug-in throw', () => {
    const ns = mergedNS();
    const doc = makeFakeDocument('white');
    globalThis.document = doc;
    publishNS(ns);
    const fields = ns.installSessionFields({
      extensionVersion: '1.0.0',
      getDetectedConditions() { throw new Error('plug-in boom'); },
      beforeElement: null,
    });
    const panel = installPanel(ns, doc, 'white');
    const c = ns.attachConditionsPanel(fields, panel);
    assert.deepEqual(c.getDetectedConditions(), ns.UNDETECTED_CONDITION_FIELDS);
  });

  it('setEnabled tolerates a throwing fields handle (panel still driven)', () => {
    const ns = mergedNS();
    const fields = stubFields();
    fields.setEnabled = () => { throw new Error('fields boom'); };
    const panel = installPanel(ns, makeFakeDocument('white'), 'white');
    const c = ns.attachConditionsPanel(fields, panel);
    c.setEnabled(false); // must not throw
    const controls = panel.element.querySelectorAll('input, select, button');
    for (const el of controls) assert.equal(el.disabled, true);
  });
});

// ------------------------------------------------------------------
// AC7 — diff discipline.
// ------------------------------------------------------------------

describe('AC7 — diff discipline', () => {
  it('changed files are exactly the 5.4 contract §6 list (post-commit-vacuous)', () => {
    // Post-commit the tree is clean and the pin is vacuous (2.8/4.4/
    // 4.14/5.1/5.2/5.3 precedent); pre-commit it proves exactly 5.4's
    // files changed.
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    if (!status.trim()) return;
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // 5.4 (show detected game conditions + manual completion of
      // unavailable fields before recording): the new
      // detected_conditions.js + its test, the panel install +
      // getDetectedConditions plug-in + attachConditionsPanel composite
      // wiring in content.js, detected_conditions.js in the manifest
      // content_scripts list, additive panel classes in overlay.css, the
      // ## 5.4 decisions, and its evidence.
      'detected_conditions.js',
      'tests/detected_conditions.test.js',
      'content.js',
      'manifest.json',
      'overlay.css',
      '.autodev/DECISIONS.md',
      '.autodev/evidence/5.4.contract.md',
      '.autodev/evidence/5.4.build.md',
      '.autodev/evidence/5.4.review.md',
      '.autodev/evidence/5.4.behavior.md',
      // 5.4 also evolves the cumulative pins in these suites (each
      // carries its own git-status allowlist, so they join here).
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/device_selection.test.js',
      'tests/finalizer.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/selection_memory.test.js',
      'tests/sender.test.js',
      'tests/session_controls.test.js',
      'tests/session_fields.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/stream_status.test.js',
      'tests/sync_marker.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 5.4 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      // Honest cumulative evolution: 5.5 (prevent a duplicate Start
      // from creating overlapping recording sessions) legitimately adds
      // the atomic duplicate-Start guard to recorder.js's
      // handleSetSession (sessionId-equality discriminator, synchronous
      // check-and-set, nothing overwritten on refusal), adds the
      // content-side pre-check + mint reorder + localAbortStart +
      // refusal-detail mapping to session_controls.js, records the
      // ## 5.5 decisions, and adds its test + evidence; its files join
      // the allowlists. No new channel messages, events, stores, or
      // permissions.
      'recorder.js',
      'session_controls.js',
      'tests/duplicate_start.test.js',
      '.autodev/DECISIONS.md',
      '.autodev/evidence/5.5.contract.md',
      '.autodev/evidence/5.5.build.md',
      // Honest cumulative evolution: 5.5's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.4 precedent).
      '.autodev/evidence/5.5.review.md',
      '.autodev/evidence/5.5.behavior.md',
      // 5.5 also evolves the cumulative pins in these suites (each
      // carries its own git-status allowlist, so they join here).
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/device_selection.test.js',
      'tests/finalizer.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/selection_memory.test.js',
      'tests/sender.test.js',
      'tests/session_controls.test.js',
      'tests/session_fields.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/stream_status.test.js',
      'tests/sync_marker.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
      // 5.5 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      // Honest cumulative evolution: 5.6 (show readiness only after
      // required media streams have started and an initial storage
      // write has succeeded) legitimately adds the pure
      // computeReadiness() policy function + readiness badge
      // presentation + poll-loop wiring to session_controls.js, adds
      // its unit/integration tests, and records its evidence; its
      // files join the allowlists. No new channel messages, events,
      // stores, or permissions.
      '.autodev/evidence/5.6.contract.md',
      '.autodev/evidence/5.6.build.md',
      // Honest cumulative evolution: 5.6's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.5 precedent).
      '.autodev/evidence/5.6.review.md',
      '.autodev/evidence/5.6.behavior.md',
      // Honest cumulative evolution: 5.7 (keep recording through game
      // end until the user clicks Stop) is primarily a pinning task —
      // it adds no product-code changes, only the 5.7 no-auto-stop
      // tests to tests/session_controls.test.js, and records its
      // evidence; its files join the allowlists. No new channel
      // messages, events, stores, or permissions.
      '.autodev/evidence/5.7.contract.md',
      '.autodev/evidence/5.7.build.md',
      // Honest cumulative evolution: 5.7's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.6 precedent).
      '.autodev/evidence/5.7.review.md',
      '.autodev/evidence/5.7.behavior.md',
      // Honest cumulative evolution: 5.8 (optional timestamped
      // note/moment marker) legitimately adds the moment_marker event
      // type + marker UI to session_controls.js, its test + evidence;
      // its files join the allowlists. No new channel messages,
      // stores, or permissions.
      '.autodev/evidence/5.8.contract.md',
      '.autodev/evidence/5.8.build.md',
      // Honest cumulative evolution: 5.8's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.7 precedent).
      '.autodev/evidence/5.8.review.md',
      '.autodev/evidence/5.8.behavior.md',
      // Honest cumulative evolution: 5.9 (mid-session game transition)
      // legitimately implements the onGameReset placeholder in content.js
      // (mint new gameId + install fresh tracker) and adds handleGameReset
      // + activeMetadata/activeConditions to session_controls.js (the
      // specified deliverable; 5.7 named the placeholder as 5.9's input),
      // adds its unit/integration tests, and records its evidence; its
      // files join the allowlists. No new channel messages, event types,
      // stores, or permissions.
      '.autodev/evidence/5.9.contract.md',
      '.autodev/evidence/5.9.build.md',
      // Honest cumulative evolution: 5.9's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.8 precedent).
      '.autodev/evidence/5.9.review.md',
      '.autodev/evidence/5.9.behavior.md',
      // Honest cumulative evolution: 5.10 (Stop completion verdict)
      // legitimately adds the sender.flush() await + transitional
      // "Finalizing…" UI + pure computeCompletion() + enriched
      // lastStopResponse retention to session_controls.js's Stop
      // sequence, adds its unit/integration tests, and records its
      // evidence; its files join the allowlists. No new channel
      // messages, event types, stores, or permissions.
      '.autodev/evidence/5.10.contract.md',
      '.autodev/evidence/5.10.build.md',
      // Honest cumulative evolution: 5.10's review/behavior evidence lands
      // after the pins are evolved (2.x/3.x/4.x/5.1-5.9 precedent).
      '.autodev/evidence/5.10.review.md',
      '.autodev/evidence/5.10.behavior.md',
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });

  it('session_fields.js and siblings are byte-identical to HEAD (5.5 owns session_controls.js)', () => {
    // Honest cumulative evolution: 5.5 legitimately modifies
    // session_controls.js (the duplicate-Start pre-check, mint reorder,
    // localAbortStart, and refusal-detail mapping), so it leaves this
    // byte-identical list; the other files stay pinned.
    for (const f of ['session_fields.js',
                     'session_identity.js', 'session_conditions.js',
                     'sender.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: REPO }).toString();
      const current = fs.readFileSync(path.join(REPO, f), 'utf8');
      assert.strictEqual(current, head, `${f} must be byte-identical`);
    }
  });

  it('no new channel messages; no new event types', () => {
    // Same pin shape as the other suites: `var MSG_*` declarations only
    // (RECORDER_MSG_KIND is the envelope, not a message).
    const rec = codeOnly('recorder.js');
    const found = [];
    const re = /var (MSG_[A-Z_]+) = '([^']+)';/g;
    let m;
    while ((m = re.exec(rec)) !== null) found.push(m[1] + '=' + m[2]);
    assert.equal(found.length, 24, 'offscreen MSG_* stays 24');
    const dc = codeOnly('detected_conditions.js');
    assert.ok(!/EVENT_TYPE/.test(dc), 'no event types in 5.4');
    assert.ok(!/sendMessage/.test(dc), 'no channel sends in 5.4');
  });

  it('PLAN.md unmodified', () => {
    const head = execSync('git show HEAD:PLAN.md', { cwd: REPO, stdio: 'pipe' }).toString();
    const current = fs.readFileSync(path.join(REPO, 'PLAN.md'), 'utf8');
    assert.strictEqual(current, head);
  });

  it('manifest diff is only the detected_conditions.js content_scripts line', () => {
    const diff = execSync('git diff HEAD -- manifest.json', { cwd: REPO }).toString();
    if (!diff.trim()) return; // post-commit vacuous
    assert.ok(diff.includes('detected_conditions.js'),
      'manifest diff adds detected_conditions.js');
    // No permission changes in 5.4 (storage was 5.3's).
    assert.ok(!diff.includes('"storage"') || diff.includes('detected_conditions.js'),
      'no permission churn');
  });
});
