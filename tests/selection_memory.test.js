// tests/selection_memory.test.js
//
// Task 5.3 (PLAN.md §5.3): remember previous selections without silently
// changing a game's recorded conditions.
//
// V1 — static + unit. Covers 5.3.contract.md AC1–AC7 (AC8–AC10 are the
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
// session_fields.js / session_controls.js resolve collaborators at call
// time via globalThis.
function mergedNS() {
  const ns = {};
  for (const f of ['session_identity.js', 'session_conditions.js',
                   'lifecycle.js', 'session_fields.js',
                   'session_controls.js', 'selection_memory.js']) {
    Object.assign(ns, freshModule(f));
  }
  return ns;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake promise-shaped storage adapter (chrome.storage.local-shaped:
// get(key) → {[key]: value}).
function makeFakeStorage(initial) {
  const data = Object.assign({}, initial || {});
  const calls = [];
  return {
    data,
    calls,
    get(key) {
      calls.push({ op: 'get', key });
      const kv = {};
      if (Object.prototype.hasOwnProperty.call(data, key)) kv[key] = data[key];
      return Promise.resolve(kv);
    },
    set(kv) {
      calls.push({ op: 'set', kv: Object.assign({}, kv) });
      Object.assign(data, kv);
      return Promise.resolve();
    },
    remove(key) {
      calls.push({ op: 'remove', key });
      delete data[key];
      return Promise.resolve();
    },
  };
}

function throwingStorage() {
  const fail = () => Promise.reject(new Error('storage dead'));
  return {
    get: fail,
    set: fail,
    remove: fail,
  };
}

// Comment-stripped source (the sync_marker.test.js precedent): full-line
// // comments, /* */ blocks, and trailing // comments removed.
function codeOnly(file) {
  return fs.readFileSync(path.join(REPO, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .map((l) => {
      const idx = l.indexOf('//');
      return idx === -1 ? l : l.slice(0, idx);
    })
    .join('\n');
}

// ------------------------------------------------------------------
// AC1 — module shape and convention.
// ------------------------------------------------------------------
describe('AC1 — module shape', () => {
  it('follows the module convention and exports the two functions', () => {
    const BS = mergedNS();
    assert.equal(typeof BS.createSelectionMemory, 'function');
    assert.equal(typeof BS.validateRememberedSelection, 'function');
  });

  it('STORAGE_KEY is the versioned prefs key', () => {
    const BS = mergedNS();
    const mem = BS.createSelectionMemory({ storage: makeFakeStorage() });
    assert.equal(mem.STORAGE_KEY, 'blindfold.sessionSelection.v1');
  });

  it('construction requires a promise-shaped storage adapter', () => {
    const BS = mergedNS();
    assert.throws(() => BS.createSelectionMemory(), TypeError);
    assert.throws(() => BS.createSelectionMemory(null), TypeError);
    assert.throws(() => BS.createSelectionMemory({}), TypeError);
    assert.throws(() => BS.createSelectionMemory({
      storage: { get() {}, set() {} }, // missing remove
    }), TypeError);
    assert.throws(() => BS.createSelectionMemory({
      storage: { get: 1, set() {}, remove() {} },
    }), TypeError);
    // Well-formed adapter constructs.
    const mem = BS.createSelectionMemory({ storage: makeFakeStorage() });
    assert.equal(typeof mem.restore, 'function');
    assert.equal(typeof mem.capture, 'function');
    // Frozen handle (repo convention for returned records).
    assert.ok(Object.isFrozen(mem));
  });

  it('header documents the 5.3 task and the no-silent-change invariant', () => {
    const src = fs.readFileSync(path.join(REPO, 'selection_memory.js'), 'utf8');
    assert.ok(src.includes('Task 5.3'), 'names the PLAN task');
    assert.ok(src.includes('no-silent-change'), 'documents the invariant');
    assert.ok(src.includes('chrome.storage.local'), 'documents the store');
  });
});

// ------------------------------------------------------------------
// AC2 — validateRememberedSelection.
// ------------------------------------------------------------------
describe('AC2 — validateRememberedSelection', () => {
  const v = () => mergedNS().validateRememberedSelection;

  it('accepts all three categories plus null', () => {
    const validate = v();
    for (const cat of ['baseline', 'training', 'evaluation', null]) {
      const clean = validate({
        sessionCategory: cat,
        trainingApproach: 'shadowing aloud',
        verbalScaffolding: '',
      });
      assert.deepEqual(clean, {
        sessionCategory: cat,
        trainingApproach: 'shadowing aloud',
        verbalScaffolding: '',
      }, 'category ' + String(cat));
    }
  });

  it('rejects unknown category strings — the whole value is corrupt', () => {
    const validate = v();
    for (const bad of ['Baseline', 'TRAINING', 'practice', '', 42, {}, []]) {
      assert.equal(validate({
        sessionCategory: bad,
        trainingApproach: 'x',
        verbalScaffolding: 'y',
      }), null, 'category ' + JSON.stringify(bad));
    }
  });

  it('coerces text fields via String(); null/undefined become empty string', () => {
    const validate = v();
    const clean = validate({
      sessionCategory: 'training',
      trainingApproach: null,
      verbalScaffolding: undefined,
    });
    assert.deepEqual(clean, {
      sessionCategory: 'training',
      trainingApproach: '',
      verbalScaffolding: '',
    });
    const coerced = validate({
      sessionCategory: 'baseline',
      trainingApproach: 42,
      verbalScaffolding: true,
    });
    assert.equal(coerced.trainingApproach, '42');
    assert.equal(coerced.verbalScaffolding, 'true');
    // Never the literal string "null" from String(null).
    assert.ok(!coerced.trainingApproach.includes('null'));
  });

  it('ignores unknown extra keys (lenient-on-input)', () => {
    const validate = v();
    const clean = validate({
      sessionCategory: 'evaluation',
      trainingApproach: 'a',
      verbalScaffolding: 'b',
      deviceId: 'x',
      extra: { nested: true },
    });
    assert.deepEqual(Object.keys(clean).sort(), [
      'sessionCategory', 'trainingApproach', 'verbalScaffolding',
    ]);
  });

  it('returns null — never throws — for missing/corrupt/wrong-shaped input', () => {
    const validate = v();
    for (const bad of [undefined, null, 42, 'x', true, [], [1, 2]]) {
      assert.equal(validate(bad), null, 'input ' + JSON.stringify(bad));
    }
    // A frozen empty object is a valid shape with all defaults.
    const clean = validate({});
    assert.deepEqual(clean, {
      sessionCategory: null,
      trainingApproach: '',
      verbalScaffolding: '',
    });
  });

  it('is a total function: never throws on adversarial input', () => {
    const validate = v();
    const evil = [undefined, null, 0, NaN, Infinity, '', 'x', [], {},
      { sessionCategory: { toString() { throw new Error('evil'); } } }];
    for (const e of evil) {
      let threw = false;
      try { validate(e); } catch (err) { threw = true; }
      assert.equal(threw, false, 'threw on ' + String(e));
    }
  });
});

// ------------------------------------------------------------------
// AC3 — restore.
// ------------------------------------------------------------------
describe('AC3 — restore', () => {
  const KEY = 'blindfold.sessionSelection.v1';

  function fieldsHandleStub() {
    const calls = [];
    return {
      calls,
      disabled: false,
      setSelection(sel) {
        calls.push(sel);
        // Faithful 5.2 write-once stub: no-op while disabled.
        if (this.disabled) return;
      },
      getSelection() { return null; },
      setEnabled(on) { this.disabled = !on; },
      getDetectedConditions() { return {}; },
    };
  }

  it('valid stored value → setSelection called with the clean selection', async () => {
    const BS = mergedNS();
    const stored = {
      sessionCategory: 'training',
      trainingApproach: 'shadowing aloud',
      verbalScaffolding: '',
      extraIgnored: 1,
    };
    const mem = BS.createSelectionMemory({
      storage: makeFakeStorage({ [KEY]: stored }),
    });
    const handle = fieldsHandleStub();
    const ok = await mem.restore(handle);
    assert.equal(ok, true);
    assert.equal(handle.calls.length, 1);
    assert.deepEqual(handle.calls[0], {
      sessionCategory: 'training',
      trainingApproach: 'shadowing aloud',
      verbalScaffolding: '',
    });
  });

  it('missing key → no call, no throw', async () => {
    const BS = mergedNS();
    const mem = BS.createSelectionMemory({ storage: makeFakeStorage() });
    const handle = fieldsHandleStub();
    const ok = await mem.restore(handle);
    assert.equal(ok, false);
    assert.equal(handle.calls.length, 0);
  });

  it('corrupt stored value → no call, no throw', async () => {
    const BS = mergedNS();
    const mem = BS.createSelectionMemory({
      storage: makeFakeStorage({ [KEY]: { sessionCategory: 'bogus' } }),
    });
    const handle = fieldsHandleStub();
    const ok = await mem.restore(handle);
    assert.equal(ok, false);
    assert.equal(handle.calls.length, 0);
  });

  it('throwing storage → no call, no throw', async () => {
    const BS = mergedNS();
    const mem = BS.createSelectionMemory({ storage: throwingStorage() });
    const handle = fieldsHandleStub();
    const ok = await mem.restore(handle);
    assert.equal(ok, false);
    assert.equal(handle.calls.length, 0);
  });

  it('does not second-guess the write-once rule: setSelection is called even when disabled', async () => {
    // The 5.2 handle itself no-ops while disabled; the memory module
    // must not add its own enabled-check (contract §5.1 — both orders
    // of the boot-adoption race are safe).
    const BS = mergedNS();
    const mem = BS.createSelectionMemory({
      storage: makeFakeStorage({ [KEY]: { sessionCategory: 'baseline' } }),
    });
    const handle = fieldsHandleStub();
    handle.disabled = true;
    const ok = await mem.restore(handle);
    assert.equal(ok, true);
    assert.equal(handle.calls.length, 1, 'restore calls setSelection unconditionally');
  });

  it('malformed handle → no throw', async () => {
    const BS = mergedNS();
    const mem = BS.createSelectionMemory({
      storage: makeFakeStorage({ [KEY]: { sessionCategory: 'baseline' } }),
    });
    for (const bad of [null, undefined, {}, { setSelection: 42 }]) {
      const ok = await mem.restore(bad);
      assert.equal(ok, false);
    }
  });
});

// ------------------------------------------------------------------
// AC4 — capture.
// ------------------------------------------------------------------
describe('AC4 — capture', () => {
  const KEY = 'blindfold.sessionSelection.v1';

  it('writes exactly {[STORAGE_KEY]: clean selection} via the adapter', async () => {
    const BS = mergedNS();
    const storage = makeFakeStorage();
    const mem = BS.createSelectionMemory({ storage });
    const ok = await mem.capture({
      sessionCategory: 'evaluation',
      trainingApproach: '  think aloud  ',
      verbalScaffolding: '',
    });
    assert.equal(ok, true);
    assert.deepEqual(storage.calls, [
      { op: 'set', kv: { [KEY]: {
        sessionCategory: 'evaluation',
        trainingApproach: '  think aloud  ',
        verbalScaffolding: '',
      } } },
    ]);
    // Capture stores the raw form value — trimming is the 1.2
    // normalizer's job at record time, not the preference's.
    assert.equal(storage.data[KEY].trainingApproach, '  think aloud  ');
  });

  it('throwing adapter → swallowed, promise resolves', async () => {
    const BS = mergedNS();
    const mem = BS.createSelectionMemory({ storage: throwingStorage() });
    const ok = await mem.capture({
      sessionCategory: 'training',
      trainingApproach: 'x',
      verbalScaffolding: 'y',
    });
    assert.equal(ok, false, 'resolves false, never rejects');
  });

  it('invalid selection → no write', async () => {
    const BS = mergedNS();
    const storage = makeFakeStorage();
    const mem = BS.createSelectionMemory({ storage });
    for (const bad of [null, undefined, 42, 'x',
                       { sessionCategory: 'bogus' }]) {
      const ok = await mem.capture(bad);
      assert.equal(ok, false);
    }
    assert.deepEqual(storage.calls, [], 'nothing written');
  });
});

// ------------------------------------------------------------------
// AC5 — no-silent-change architectural pins.
// ------------------------------------------------------------------
describe('AC5 — no-silent-change architectural pins', () => {
  it('selection_memory.js has no record-write path (comment-stripped scan)', () => {
    const code = codeOnly('selection_memory.js');
    for (const token of ['session-save', 'saveSessionMetadata',
                         'saveConditions', 'indexedDB',
                         'chrome.runtime.sendMessage']) {
      assert.ok(!code.includes(token),
        'forbidden token present: ' + token);
    }
    // The module never touches the chrome global directly — the
    // adapter is built in content.js and injected.
    assert.ok(!/\bchrome\b/.test(code),
      'the chrome global must not appear in selection_memory.js');
  });

  it('selection_memory.js is listed in content_scripts only', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
    assert.ok(manifest.content_scripts[0].js.includes('selection_memory.js'),
      'listed in content_scripts');
    // Never in the SW importScripts.
    const sw = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
    assert.ok(!sw.includes('selection_memory.js'),
      'must not be imported into the service worker');
    // Never in the offscreen document.
    const recorderHtml = fs.readFileSync(
      path.join(REPO, 'recorder.html'), 'utf8');
    assert.ok(!recorderHtml.includes('selection_memory.js'),
      'must not be loaded in the offscreen document');
  });

  it('no new channel messages and no new event types in 5.3', () => {
    const diff = execSync('git diff HEAD --stat', { cwd: REPO }).toString();
    // session_controls.js / content.js / manifest.json / selection_memory.js
    // only — recorder.js and recording_host.js are untouched by 5.3.
    // Honest cumulative evolution: 5.5's duplicate-Start guard touches
    // recorder.js (the handleSetSession guard only — purely additive);
    // recording_host.js and sw.js stay untouched.
    const touched = diff.split('\n').filter((l) => l.includes('|'))
      .map((l) => l.split('|')[0].trim());
    for (const f of ['recording_host.js', 'sw.js']) {
      assert.ok(!touched.includes(f), f + ' must be untouched by 5.5');
    }
    if (touched.includes('recorder.js')) {
      // 5.5's guard is purely additive: the session-active refusal block
      // in handleSetSession. No lines removed, no new messages.
      const rdiff = execSync('git diff HEAD -- recorder.js', { cwd: REPO }).toString();
      const radded = rdiff.split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
        .map((l) => l.slice(1));
      const bad = radded.filter((l) => {
        const t = l.trim();
        return !(t === '' || t.startsWith('//') || t.startsWith('}') ||
          t.startsWith('{') || t.startsWith('try {') ||
          t.startsWith('} catch') || t.includes('5.5') ||
          t.includes('session-active') || t.includes('isSessionActive()') ||
          t.includes('sid') || t.includes('sendResponse') ||
          t === 'return false;');
      });
      assert.deepEqual(bad, [],
        'recorder.js diff is only the 5.5 guard:\n' + bad.join('\n'));
      const rremoved = rdiff.split('\n')
        .filter((l) => l.startsWith('-') && !l.startsWith('---'))
        .map((l) => l.slice(1).trim())
        .filter((l) => l !== '');
      assert.deepEqual(rremoved, [], '5.5 removes nothing from recorder.js');
    }
    const controls = codeOnly('session_controls.js');
    const ensureCount = (controls.match(/onSessionStarted/g) || []).length;
    assert.ok(ensureCount > 0, 'onSessionStarted wiring present');
  });
});

// ------------------------------------------------------------------
// AC6 — wiring and diff discipline.
// ------------------------------------------------------------------
describe('AC6 — wiring and diff discipline', () => {
  it('changed files are exactly the 5.3 contract §5 list (post-commit-vacuous)', () => {
    // Post-commit the tree is clean and the pin is vacuous (2.8/4.4/
    // 4.14/5.1/5.2 precedent); pre-commit it proves exactly 5.3's files
    // changed.
    const status = execSync('git status --porcelain', { cwd: REPO }).toString();
    if (!status.trim()) return;
    const changed = status.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
    const allowed = new Set([
      // 5.3 (remember previous selections): the new selection_memory.js
      // + its test, the optional onSessionStarted hook in
      // session_controls.js (option + single guarded call site), the
      // memory construction + restore + hook pass-through in
      // content.js, the "storage" permission + selection_memory.js
      // content_scripts line in manifest.json, the ## 5.3 decisions,
      // and its evidence.
      'selection_memory.js',
      'tests/selection_memory.test.js',
      // 5.3 also evolves the exact-permissions pins in these suites
      // (they carry no git-status allowlist of their own, so they join
      // here).
      'tests/db.test.js',
      'tests/manifest_sw.test.js',
      // 5.3 also evolves the working-tree diff pins in these suites.
      'tests/clock_link.test.js',
      'tests/timecode.test.js',
      'session_controls.js',
      'content.js',
      'manifest.json',
      '.autodev/evidence/5.3.contract.md',
      '.autodev/evidence/5.3.build.md',
      // Honest cumulative evolution: 5.3's review/behavior evidence
      // lands after the pins are evolved (2.x/3.x/4.x/5.1/5.2 precedent).
      '.autodev/evidence/5.3.review.md',
      '.autodev/evidence/5.3.behavior.md',
      // Honest cumulative evolution: 5.4 (show detected game conditions
      // and allow manual completion of unavailable fields before
      // recording) legitimately adds detected_conditions.js
      // (detectGameConditions + CONDITION_PROBES + installConditionsPanel
      // + attachConditionsPanel; playerColor detected via the verified
      // wc-chess-board/flipped probe, the other four fields manual-only),
      // wires the panel install + getDetectedConditions plug-in +
      // attachConditionsPanel composite into content.js, adds
      // detected_conditions.js to manifest.json, adds additive panel
      // classes to overlay.css, records the ## 5.4 decisions, and adds
      // its test + evidence; its files join the allowlists.
      // (content.js, manifest.json and .autodev/DECISIONS.md are already
      // allowlisted from 5.1/5.2/5.3; overlay.css is new to this
      // suite's allowlist — 5.3 did not touch it.)
      'overlay.css',
      'detected_conditions.js',
      'tests/detected_conditions.test.js',
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
      '.autodev/DECISIONS.md',
      // Cumulative pin evolutions by the 5.3 build (honest cumulative
      // evolution — earlier suites' allowlists admit 5.3's files).
      'tests/attempt_tracker.test.js',
      'tests/audio_policy.test.js',
      'tests/capture_selection.test.js',
      'tests/chunk_writer.test.js',
      'tests/clock_link.test.js',
      'tests/device_selection.test.js',
      'tests/finalizer.test.js',
      'tests/format_support.test.js',
      'tests/game_lifecycle.test.js',
      'tests/history_tracker.test.js',
      'tests/lifecycle.test.js',
      'tests/recording_host.test.js',
      'tests/retention.test.js',
      'tests/sender.test.js',
      'tests/session_controls.test.js',
      'tests/session_fields.test.js',
      'tests/session_store.test.js',
      'tests/speech.test.js',
      'tests/status_indicator.test.js',
      'tests/stream_starter.test.js',
      'tests/stream_status.test.js',
      'tests/sync_marker.test.js',
      'tests/timecode.test.js',
      'tests/track_monitor.test.js',
      'tests/visibility.test.js',
      'tests/writer.test.js',
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
      // Honest cumulative evolution: 6.1 (generate metadata.json from
      // stored context and observed completion status) legitimately adds
      // the new SW-side exporter.js module (pure buildMetadataJson
      // builder; 6.6 owns the orchestration/permission/message), its
      // test file, and its evidence; its files join the allowlists.
      // No new channel messages, event types, stores, or permissions
      // in 6.1. The section audit/architecture evidence files
      // (section-5.audit.md, created by the section auditor after 5.10's
      // pins; section-6.architecture.md, the §6 planner's) are
      // allowlisted here to repair the stale pins.
      'exporter.js',
      'tests/exporter.test.js',
      '.autodev/evidence/6.1.contract.md',
      '.autodev/evidence/6.1.build.md',
      '.autodev/evidence/section-5.audit.md',
      '.autodev/evidence/section-6.architecture.md',
      // Honest cumulative evolution: 6.1's review/behavior evidence lands
      // after the pins are evolved (2.x-5.x precedent).
      '.autodev/evidence/6.1.review.md',
      '.autodev/evidence/6.1.behavior.md',
    ]);
    const stray = changed.filter((f) => !allowed.has(f));
    assert.deepEqual(stray, [],
      'working tree has non-5.3 changes:\n' + stray.join('\n'));
  });

  it('session_controls.js diff is only the onSessionStarted option + call site', () => {
    const diff = execSync('git diff HEAD -- session_controls.js', { cwd: REPO }).toString();
    if (!diff.trim()) return; // committed
    const structural = (l) =>
      l.trim() === '' || l.trim().startsWith('//') ||
      l.trim().startsWith('}') || l.trim().startsWith('try {') ||
      l.trim().startsWith('} catch') || l.trim().startsWith('{') ||
      l.trim() === '});';
    const added = diff.split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1));
    assert.ok(added.length > 0, 'expected the onSessionStarted wiring as added lines');
    // The 'extensionVersion: extensionVersion,' added line is the
    // comma-only change where the new onSessionStarted field joins the
    // returned options object (the comma-less version is the only
    // removed line in the 5.3 delta, asserted below).
    // Honest cumulative evolution: 5.5's duplicate-Start defense adds
    // the localAbortStart helper, the pre-check after recorder-ensure,
    // moves minting after the pre-check, and maps the session-active
    // refusal to the honest abort path. Its added lines are 5.5-keyworded
    // or moved verbatim from the old minting block (they also appear as
    // removed lines, asserted below).
    const kw55 = (l) =>
      l.includes('5.5') || l.includes('localAbortStart') ||
      l.includes('duplicate-start') || l.includes('session-active') ||
      l.includes('MSG_GET_STATUS') || l.includes('statusResp') ||
      l.includes('ensureResp') || l.includes('pre-check') ||
      l.includes('handledAbort') || l.includes('detailText') ||
      l.includes('factoriesOk') || l.includes('setSlots(null, null)') ||
      l.includes('lastStartResults = {}') || l.includes('return null;') ||
      l.includes('fieldsHandle !== null');
    // Honest cumulative evolution: 5.6's readiness policy adds the pure
    // computeReadiness() function, the readiness badge DOM + rendering,
    // and the poll-loop wiring. Its added lines are 5.6-keyworded or
    // use the readiness/storage vocabulary.
    const kw56 = (l) =>
      l.includes('5.6') || l.includes('readiness') || l.includes('Readiness') ||
      l.includes('READINESS') || l.includes('computeReadiness') ||
      l.includes('classifyStorageReadiness') || l.includes('isTransientSenderError') ||
      l.includes('pageStartEmitted') || l.includes('readinessLatched') ||
      l.includes('resetReadiness') || l.includes('renderReadiness') ||
      l.includes('senderStatus') || l.includes('lastError') ||
      l.includes('pendingCount') || l.includes('storage') ||
      l.includes('initialEmitObserved') || l.includes('blocked') ||
      l.includes('verdict') || l.includes('reasons') ||
      l.includes('send-timeout') || l.includes('no-ack') ||
      l.includes('transport-error') || l.includes('ready:') ||
      l.includes('reason:') || l.includes('streamStatuses') ||
      l.includes('startResults') || l.trim() === 'return {' ||
      l.trim() === ']);' || l.includes('allStreamsReady') ||
      l.includes('STREAM_KINDS') || l.includes('var kind =') ||
      l.includes('st === null') || l.includes('Object.freeze') ||
      l.includes('throw new TypeError') || l.includes('classified') ||
      l.includes('dataState') || l.includes('LIGHT_') ||
      l.trim() === 'continue;' || l.includes('var text;') ||
      l.includes('text =') || l.includes('opts.sender') ||
      l.trim().startsWith('return;') || l.trim() === 'text;';
    // Honest cumulative evolution: 5.8's moment marker adds the
    // moment_marker event type + payload validator + marker input +
    // Mark button UI + click-handler wiring. Its added lines are
    // 5.8-keyworded or use the marker vocabulary.
    const kw58 = (l) =>
      l.includes('5.8') || l.includes('moment_marker') ||
      l.includes('MOMENT_MARKER') || l.includes('MomentMarker') ||
      l.includes('markerInput') || l.includes('markerButton') ||
      l.includes('setMarkerEnabled') || l.includes('onMarkerClick') ||
      l.includes('markerFailureLabel') || l.includes('marker-failed') ||
      l.includes('blindfold-moment') || l.includes('payload.note') ||
      l.includes('payload must') || l.includes('var note =') ||
      l.includes('var keys =') || l.includes('Object.keys') ||
      l.includes('etName') || l.includes('RangeError') ||
      l.includes('Optional note for moment marker') ||
      l.includes('var name =') || l.includes('e.name') ||
      l.includes('isPlainObject(payload)') || l.includes('keys.length') ||
      l.includes("keys[0]") || l.includes('typeof note') ||
      l.includes('return payload;') || l.includes('if (!enabled)') ||
      l.includes('CONTROL_PHASE_ACTIVE') || l.includes('var raw') ||
      l.includes('var trimmed') || l.includes('activeSessionId') ||
      l.includes('activeGameId') || l.includes("raw = ''") ||
      l.includes('trimmed ===') || l.includes('payload: payload');
    // Honest cumulative evolution: 5.9's mid-session game transition
    // adds activeMetadata/activeConditions retention, the handleGameReset
    // method (mint → session-save → recorder re-set → slots), and the
    // setSlots null-clearing. Its added lines are 5.9-keyworded.
    const kw59 = (l) =>
      l.includes('5.9') || l.includes('handleGameReset') ||
      l.includes('activeMetadata') || l.includes('activeConditions') ||
      l.includes('newGameId') || l.includes('addGameToSession') ||
      l.includes('gameResetFailed') || l.includes('updatedMetadata') ||
      l.includes('not-active') || l.includes('no-metadata') ||
      l.includes('mint-failed') || l.includes('metadata-invalid') ||
      l.includes('session-save-failed') || l.includes('set-session-failed') ||
      l.includes('sessionId === null && gameId === null') ||
      l.includes('channelCall') || l.includes('MSG_SESSION_SAVE') ||
      l.includes('MSG_SET_SESSION') || l.includes('.then(') ||
      l.includes('isPlainObject') || l.includes('saveResp') ||
      l.includes('setResp') || l.includes('setExtra') ||
      l.includes('sessionCategory') || l.includes('cat') ||
      l.includes('CONTROL_PHASE_ACTIVE') ||
      l.includes('Promise.resolve') || l.includes('e.error') ||
      l.includes('internal-error');
    // Honest cumulative evolution: 5.10's Stop completion verdict adds
    // the pure computeCompletion() function, the sender.flush() await +
    // transitional "Finalizing…" UI + finalizeStop() + enriched
    // lastStopResponse retention. Its added lines are 5.10-keyworded
    // or use the completion/flush vocabulary.
    const kw510 = (l) =>
      l.includes('5.10') || l.includes('computeCompletion') ||
      l.includes('COMPLETION') || l.includes('finalizeStop') ||
      l.includes('Finalizing') || l.includes('finalize-warnings') ||
      l.includes('complete-with-warnings') || l.includes('flushResult') ||
      l.includes('flush-result') || l.includes('stopResp') ||
      l.includes('enriched') || l.includes('completion') ||
      l.includes('verdict') || l.includes('warnings') ||
      l.includes('sender.flush') || l.includes('flushPromise') ||
      l.includes('delivered') || l.includes('pending') ||
      l.includes('undelivered') || l.includes('flush-timed-out') ||
      l.includes('-failed:') || l.includes('missing-stream-result') ||
      l.includes('stop-response-malformed') ||
      l.includes('completion-computation-failed') ||
      l.includes('Promise.resolve(flushPromise)') ||
      l.includes('streams') || l.includes('errDetail') ||
      l.includes('st.error') || l.includes('detail') ||
      l.includes('STOPPING') || l.includes('wasStopping');
    const removed = diff.split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .map((l) => l.slice(1).trim())
      .filter((l) => l !== '');
    const bad55 = added.filter((l) =>
      !(structural(l) || l.includes('onSessionStarted') || l.includes('5.3') ||
        l.trim() === 'extensionVersion: extensionVersion,' ||
        kw55(l) || kw56(l) || kw58(l) || kw59(l) || kw510(l) || removed.includes(l.trim())));
    assert.deepEqual(bad55, [], 'unexpected added lines in session_controls.js:\n' + bad55.join('\n'));
    const badRemoved = removed.filter((l) =>
      !(l === 'extensionVersion: extensionVersion' ||
        added.some((a) => a.trim() === l) || // 5.5 moved the minting block
        l.startsWith('//') || // 5.5 rewrote the contract-order comment
        l.includes('abortStart(') || // → localAbortStart
        l === 'return;' || // → throw { handledAbort: true }
        l === 'var factoriesOk =' || // 5.5 restructured the declaration
        l === 'lastStopResponse = stopResp;' || // 5.10 enriched retention
        l === 'opts.onStopComplete(stopResp);' || // 5.10 enriched handoff
        l === "setButton('Start', true, null, 'Start recording session');")); // 5.10 warning detail
    assert.deepEqual(badRemoved, [],
      'unexpected removed lines in session_controls.js:\n' + badRemoved.join('\n'));
    // No new offscreen MSG_* constants (5.3 and 5.5 add no channel messages).
    const addedMsgConsts = added.filter((l) => /var MSG_[A-Z_]+ =/.test(l));
    assert.deepEqual(addedMsgConsts, [], 'no new MSG_* constants');
  });

  it('content.js diff is only the 5.3 memory wiring', () => {
    const diff = execSync('git diff HEAD -- content.js', { cwd: REPO }).toString();
    if (!diff.trim()) return; // committed
    const structural = (l) =>
      l.trim() === '' || l.trim().startsWith('//') ||
      l.trim().startsWith('/*') ||
      l.trim().startsWith('}') || l.trim().startsWith('try {') ||
      l.trim().startsWith('} catch') || l.trim().startsWith('{') ||
      l.trim() === '});' || l.trim() === '},' || l.trim() === '});' ||
      l.trim().startsWith('(') || l.trim() === 'return;';
    const kw53 = (l) =>
      l.includes('5.3') || l.includes('selectionMemory') ||
      l.includes('SelectionMemory') || l.includes('onSessionStarted') ||
      l.includes('selectionStorageLocal') || l.includes('storageLocal') ||
      l.includes('chrome.storage') || l.includes('.capture(') ||
      l.includes('.restore(') || l.includes('memErr') ||
      l.includes('sessionFieldsHandle') ||
      l.includes('storage: {') || l.includes('get: function') ||
      l.includes('set: function') || l.includes('remove: function');
    // Honest cumulative evolution: 5.3's memory wiring is committed (in
    // HEAD), so the uncommitted delta is 5.4's panel wiring — the
    // conditionsPanelHandle declaration, the installConditionsPanel
    // install before the fields, the getDetectedConditions plug-in
    // pass-through, and the attachConditionsPanel composite wrap.
    const kw54 = (l) =>
      l.includes('5.4') || l.includes('conditionsPanelHandle') ||
      l.includes('ConditionsPanel') || l.includes('installConditionsPanel') ||
      l.includes('attachConditionsPanel') ||
      l.includes('getDetectedConditions') || l.includes('panelErr') ||
      l.includes('rmErr') || l.includes('undefined') ||
      l.includes('sessionControlsHandle') || l.includes('beforeElement');
    // Honest cumulative evolution: 5.9 implements the onGameReset
    // placeholder (mint new game identity + install fresh tracker) —
    // createGameHistoryTracker factory, handleGameResetEvent, let
    // historyTracker/game bindings, and the handleGameReset call.
    const kw59 = (l) =>
      l.includes('5.9') || l.includes('createGameHistoryTracker') ||
      l.includes('createHistoryTracker') ||
      l.includes('handleGameResetEvent') || l.includes('handleGameReset') ||
      l.includes('historyTracker') || l.includes('resetEnded') ||
      l.includes('newGameId') || l.includes('onGameReset') ||
      l.includes('gameId:') || l.includes('emitEvent') ||
      l.includes('sender.emit') || l.includes('activeSessionId') ||
      l.includes('activeGameId') || l.includes('payload,') ||
      l.includes('refs:') || l.includes('eventType,') ||
      l.includes('let historyTracker') || l.includes('let game =') ||
      l.includes('getGame()') || l.includes('sessionControlsHandle') ||
      l.includes('Promise.resolve') || l.includes('.then(function') ||
      l.includes('.catch(function') || l.includes('res.ok') ||
      l.includes('res.newGameId') || l.includes('attemptTracker') ||
      l.includes('gameLifecycleRecorder') || l.includes('recordGameReset') ||
      l.includes('confirmedMoveCount');
    const added = diff.split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1));
    assert.ok(added.length > 0, 'expected the memory wiring as added lines');
    const bad = added.filter((l) => !(structural(l) || kw53(l) || kw54(l) || kw59(l)));
    assert.deepEqual(bad, [], 'unexpected added lines in content.js:\n' + bad.join('\n'));
    const removed = diff.split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .map((l) => l.slice(1).trim())
      .filter((l) => l !== '');
    // 5.4 restructures the 5.2 install block (the panel installs before
    // the fields); removed lines are the superseded 5.2 wiring.
    // 5.9 restructures the tracker creation into the
    // createGameHistoryTracker factory (const→let); removed lines are
    // the superseded inline creation.
    const badRemoved = removed.filter((l) =>
      !(structural(l) || l.includes('5.2') || l.includes('installSessionFields') ||
        l.includes('sessionControlsHandle') || l.includes('beforeElement') ||
        l.includes('fieldsErr') || l.includes('5.4') ||
        l.includes('UNDETECTED_CONDITION_FIELDS') ||
        l.includes('historyTracker') || l.includes('createHistoryTracker') ||
        l.includes('const game =') || l.includes('onGameReset') ||
        l.includes('gameId:') || l.includes('emitEvent') ||
        l.includes('sender.emit') || l.includes('activeSessionId') ||
        l.includes('activeGameId') || l.includes('attemptTracker') ||
        l.includes('gameLifecycleRecorder') || l.includes('recordGameReset') ||
        l.includes('confirmedMoveCount') || l.includes('§5: mint new game') ||
        l.includes('eventType,') || l.includes('payload,') ||
        l.includes('refs:')));
    assert.deepEqual(badRemoved, [],
      'unexpected removed lines in content.js:\n' + badRemoved.join('\n'));
    // No new top-level function declarations except 5.9's specified
    // factory + reset callback (createGameHistoryTracker,
    // handleGameResetEvent).
    const newFns = diff.split('\n')
      .filter((l) => /^\+function /.test(l))
      .map((l) => l.slice(1).trim());
    const badFns = newFns.filter((l) =>
      !(l.startsWith('function createGameHistoryTracker') ||
        l.startsWith('function handleGameResetEvent')));
    assert.deepEqual(badFns, [],
      'unexpected new functions in content.js: ' + badFns.join(', '));
  });

  it('manifest.json diff is only the detected_conditions.js line (5.4)', () => {
    // 5.3's storage permission + selection_memory.js line are committed
    // (in HEAD); the uncommitted delta is 5.4's detected_conditions.js
    // content_scripts line per its contract.
    const diff = execSync('git diff HEAD -- manifest.json', { cwd: REPO }).toString();
    if (!diff.trim()) return; // committed
    const added = diff.split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1));
    assert.ok(added.length >= 1);
    for (const l of added) {
      assert.ok(l.includes('detected_conditions.js'),
        'manifest addition must be the detected_conditions.js line: ' + l);
    }
    const removed = diff.split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .map((l) => l.slice(1));
    for (const l of removed) {
      assert.ok(l.includes('selection_memory.js'),
        'manifest removal must be the superseded js line: ' + l);
    }
  });

  it('PLAN.md is unmodified', () => {
    const diff = execSync('git diff main -- PLAN.md', { cwd: REPO }).toString();
    assert.equal(diff.trim(), '', 'PLAN.md must never be modified');
  });

  it('recorder.js, recording_host.js, sw.js are untouched by 5.3 (no new messages)', () => {
    // Honest cumulative evolution: 5.5's duplicate-Start guard touches
    // recorder.js (the handleSetSession guard only — purely additive,
    // asserted above); recording_host.js and sw.js stay untouched.
    for (const f of ['recording_host.js', 'sw.js']) {
      const diff = execSync(`git diff HEAD -- ${f}`, { cwd: REPO }).toString();
      assert.equal(diff.trim(), '', f + ' must be untouched by 5.5');
    }
  });
});

// ------------------------------------------------------------------
// AC7 — onSessionStarted contract (full Start harness).
// ------------------------------------------------------------------

// Minimal DOM stub: only what installSessionFields and
// installSessionControls touch.
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    type: '',
    parentNode: null,
    children: [],
    _attrs: {},
    _clickHandlers: [],
    setAttribute(k, v) { this._attrs[String(k)] = String(v); },
    getAttribute(k) {
      const key = String(k);
      return Object.prototype.hasOwnProperty.call(this._attrs, key) ?
        this._attrs[key] : null;
    },
    removeAttribute(k) { delete this._attrs[String(k)]; },
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
    addEventListener(type, fn) {
      if (type === 'click') this._clickHandlers.push(fn);
    },
    click() { for (const fn of this._clickHandlers.slice()) fn(); },
  };
  return el;
}

function makeFakeDocument() {
  const body = makeEl('body');
  return {
    body,
    createElement: (tag) => makeEl(tag),
    getElementById: () => null, // fallback path for both installs
  };
}

describe('AC7 — onSessionStarted', () => {
  let savedNS;
  let savedDocument;

  function publish(BS) {
    savedNS = globalThis.BlindfoldSession;
    // lifecycle.js's real emitPageStart needs a sender with emit();
    // the harness sender below provides it.
    globalThis.BlindfoldSession = BS;
  }

  beforeEach(() => {
    savedDocument = globalThis.document;
    globalThis.document = makeFakeDocument();
  });

  afterEach(() => {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedNS === undefined) delete globalThis.BlindfoldSession;
    else globalThis.BlindfoldSession = savedNS;
    savedNS = undefined;
  });

  // Installs fields + controls with a transport that answers the full
  // 5.2 Start sequence. Returns the harness.
  function startHarness({ onSessionStarted, ensureOk = true } = {}) {
    const BS = mergedNS();
    publish(BS);
    const transport = {
      calls: [],
      fn(env) {
        this.calls.push(env);
        if (env.msg === 'recorder-ensure') {
          return ensureOk ?
            Promise.resolve({ ok: true, bootId: 'b', created: true }) :
            Promise.resolve({ ok: false, reason: 'denied' });
        }
        if (env.msg === 'session-save') return Promise.resolve({ ok: true });
        if (env.msg === 'recorder-set-session') return Promise.resolve({ ok: true });
        if (env.msg === 'recorder-start-streams') {
          return Promise.resolve({
            ok: true,
            streams: {
              microphone: { ok: true },
              screen: { ok: true },
              webcam: { ok: true },
            },
          });
        }
        if (env.msg === 'recorder-get-status') {
          return Promise.resolve({ ok: false, error: 'no-session' });
        }
        return Promise.resolve({ ok: false, error: 'unexpected' });
      },
    };
    const sender = { emit() { return { eventId: 'e1' }; } };
    const glr = {
      recordStopTermination() { return 'event-id'; },
      resetEnded() {},
      getLastObservedEnd() { return null; },
    };
    const fields = BS.installSessionFields({ extensionVersion: '1.0.0' });
    const startedCalls = [];
    const opts = {
      sender,
      sendRecorderMessage: (env) => transport.fn(env),
      gameLifecycleRecorder: glr,
      intervalMs: 60000, // no real polling in the harness
      sessionFields: fields,
      extensionVersion: '1.0.0',
      onSessionStarted: onSessionStarted === undefined ?
        ((sel) => { startedCalls.push(sel); }) : onSessionStarted,
    };
    const h = BS.installSessionControls(opts);
    return { BS, fields, h, transport, startedCalls };
  }

  it('fires exactly once per successful Start with the recorded selection', async () => {
    const { fields, h, startedCalls } = startHarness();
    try {
      fields.select.value = 'training';
      fields.approachInput.value = 'shadowing aloud';
      fields.scaffoldingInput.value = '';
      h.button.click(); // Start
      await sleep(60);
      assert.equal(h.getPhase(), 'active');
      assert.equal(startedCalls.length, 1, 'fired exactly once');
      assert.deepEqual(startedCalls[0], {
        sessionCategory: 'training',
        trainingApproach: 'shadowing aloud',
        verbalScaffolding: '',
      }, 'called with the recorded selection');
    } finally { h.stop(); }
  });

  it('is not fired on the no-category abort path', async () => {
    const { fields, h, startedCalls, transport } = startHarness();
    try {
      // Category left at the placeholder → honest abort.
      fields.approachInput.value = 'x';
      h.button.click();
      await sleep(60);
      assert.equal(h.getPhase(), 'idle');
      assert.equal(startedCalls.length, 0, 'not fired on abort');
      assert.ok(!transport.calls.some((c) => c.msg === 'session-save'),
        'no session-save on the abort path');
    } finally { h.stop(); }
  });

  it('is not fired on the ensure-failure abort path', async () => {
    const { fields, h, startedCalls } = startHarness({ ensureOk: false });
    try {
      fields.select.value = 'baseline';
      h.button.click();
      await sleep(60);
      assert.equal(h.getPhase(), 'idle');
      assert.equal(startedCalls.length, 0, 'not fired on abort');
    } finally { h.stop(); }
  });

  it('a throwing callback does not break Start (fault injection)', async () => {
    const { fields, h, startedCalls } = startHarness({
      onSessionStarted: () => { throw new Error('boom'); },
    });
    try {
      fields.select.value = 'evaluation';
      h.button.click();
      await sleep(60);
      assert.equal(h.getPhase(), 'active', 'Start still reaches active');
      assert.equal(startedCalls.length, 0);
    } finally { h.stop(); }
  });

  it('onSessionStarted is optional (5.1/5.2-era callers stay compatible)', () => {
    const BS = mergedNS();
    publish(BS);
    const sender = { emit() { return { eventId: 'e1' }; } };
    const glr = {
      recordStopTermination() { return 'event-id'; },
      resetEnded() {},
      getLastObservedEnd() { return null; },
    };
    const h = BS.installSessionControls({
      sender,
      sendRecorderMessage: () => Promise.resolve({ ok: false }),
      gameLifecycleRecorder: glr,
      intervalMs: 60000,
    });
    try {
      assert.equal(h.getPhase(), 'idle');
    } finally { h.stop(); }
    assert.throws(() => BS.installSessionControls({
      sender,
      sendRecorderMessage: () => Promise.resolve({ ok: false }),
      gameLifecycleRecorder: glr,
      intervalMs: 60000,
      onSessionStarted: 'yes',
    }), TypeError, 'non-function onSessionStarted is a TypeError');
  });

  it('end-to-end: capture at Start → restore pre-fills the next install', async () => {
    // The 5.3 loop across two installs sharing one storage backend.
    // The namespace is published manually here (startHarness also
    // publishes; the manual publish keeps one owner for restore).
    const BS = mergedNS();
    const prevNS = globalThis.BlindfoldSession;
    globalThis.BlindfoldSession = BS;
    const storage = makeFakeStorage();
    const mem1 = BS.createSelectionMemory({ storage });
    const fields = BS.installSessionFields({ extensionVersion: '1.0.0' });
    const transport = {
      fn(env) {
        if (env.msg === 'recorder-ensure') {
          return Promise.resolve({ ok: true, bootId: 'b', created: true });
        }
        if (env.msg === 'session-save') return Promise.resolve({ ok: true });
        if (env.msg === 'recorder-set-session') {
          return Promise.resolve({ ok: true });
        }
        if (env.msg === 'recorder-start-streams') {
          return Promise.resolve({
            ok: true,
            streams: {
              microphone: { ok: true },
              screen: { ok: true },
              webcam: { ok: true },
            },
          });
        }
        return Promise.resolve({ ok: false, error: 'no-session' });
      },
    };
    const h = BS.installSessionControls({
      sender: { emit() { return { eventId: 'e1' }; } },
      sendRecorderMessage: (env) => transport.fn(env),
      gameLifecycleRecorder: {
        recordStopTermination() { return 'event-id'; },
        resetEnded() {},
        getLastObservedEnd() { return null; },
      },
      intervalMs: 60000,
      sessionFields: fields,
      extensionVersion: '1.0.0',
      onSessionStarted: (sel) => { mem1.capture(sel); },
    });
    try {
      fields.select.value = 'training';
      fields.approachInput.value = 'shadowing aloud';
      h.button.click();
      await sleep(60);
      assert.equal(h.getPhase(), 'active');
    } finally { h.stop(); }
    // Second install (new page load): restore pre-fills the form.
    const mem2 = BS.createSelectionMemory({ storage });
    const fields2 = BS.installSessionFields({ extensionVersion: '1.0.0' });
    const ok = await mem2.restore(fields2);
    globalThis.BlindfoldSession = prevNS;
    assert.equal(ok, true);
    assert.deepEqual(fields2.getSelection(), {
      sessionCategory: 'training',
      trainingApproach: 'shadowing aloud',
      verbalScaffolding: '',
    });
  });
});
