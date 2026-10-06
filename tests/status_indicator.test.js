// tests/status_indicator.test.js
//
// Task 2.8 (PLAN.md §2.8): surface write failures and storage-capacity
// problems in the session status indicator.
//
// V1 — static + unit. Covers 2.8.contract.md AC1–AC12 (AC15 is V3-deferred
// to §7; AC13–AC14 are the V2 harness).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function freshModule() {
  delete require.cache[require.resolve('../status_indicator.js')];
  return require('../status_indicator.js');
}

// ------------------------------------------------------------------
// Minimal DOM stub. Only what installStatusIndicator touches:
// createElement, getElementById, body.appendChild, parentNode.insertBefore,
// className (counted), setAttribute/getAttribute/removeAttribute, title.
// ------------------------------------------------------------------
function makeFakeDocument(withInput) {
  const elements = [];
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      _cls: '',
      _classSets: 0,
      _attrs: {},
      _id: null,
      textContent: '',
      parentNode: null,
      children: [],
      setAttribute(k, v) { this._attrs[String(k)] = String(v); },
      getAttribute(k) {
        const key = String(k);
        return Object.prototype.hasOwnProperty.call(this._attrs, key)
          ? this._attrs[key] : null;
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
      }
    };
    Object.defineProperty(el, 'className', {
      configurable: true,
      get() { return this._cls; },
      set(v) { this._classSets++; this._cls = String(v); }
    });
    elements.push(el);
    return el;
  }
  const body = makeEl('body');
  let input = null;
  if (withInput) {
    input = makeEl('input');
    input._id = 'blindfold-chess-move-input';
    body.appendChild(input);
  }
  return {
    body,
    input,
    createElement: makeEl,
    getElementById(id) {
      return elements.find((e) => e._id === id) || null;
    }
  };
}

function makeSender(status) {
  let current = status;
  return {
    getStatus() { return current; },
    _set(s) { current = s; }
  };
}

function baseStatus(overrides) {
  return Object.assign({
    pendingCount: 0,
    lastError: null,
    transportAvailable: true,
    retryScheduled: false
  }, overrides);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// AC1: module convention + exports.
// ------------------------------------------------------------------
describe('AC1 — module convention', () => {
  it('follows the guarded-global / IIFE / Node-shim convention and exports both functions', () => {
    const BS = freshModule();
    assert.equal(typeof BS.classifySenderStatus, 'function');
    assert.equal(typeof BS.installStatusIndicator, 'function');
    assert.equal(BS.STATUS_HEALTHY, 'healthy');
    assert.equal(BS.STATUS_DEGRADED_RETRYING, 'degraded-retrying');
    assert.equal(BS.STATUS_FAILED_PERSISTENT, 'failed-persistent');
    assert.equal(BS.STATUS_FAILED_STORAGE_FULL, 'failed-storage-full');
    assert.equal(BS.STATUS_POLL_INTERVAL_MS, 2000);
    const src = fs.readFileSync(path.join(ROOT, 'status_indicator.js'), 'utf8');
    assert.ok(src.includes("var BlindfoldSession = BlindfoldSession || {};"));
    assert.ok(src.includes("'use strict';"));
    assert.ok(src.includes('module.exports = BlindfoldSession;'));
  });
});

// ------------------------------------------------------------------
// AC2–AC6: pure classification.
// ------------------------------------------------------------------
describe('AC2–AC6 — classifySenderStatus', () => {
  it('AC2: lastError null → healthy with null detail (pending 0/>0, transport t/f)', () => {
    const BS = freshModule();
    for (const s of [
      baseStatus({ pendingCount: 0, transportAvailable: true }),
      baseStatus({ pendingCount: 3, transportAvailable: true }),
      baseStatus({ pendingCount: 5, transportAvailable: false }),
      baseStatus({ pendingCount: 0, transportAvailable: false, retryScheduled: true })
    ]) {
      const c = BS.classifySenderStatus(s);
      assert.equal(c.state, 'healthy');
      assert.equal(c.detail, null);
      assert.ok(Object.isFrozen(c));
    }
  });

  it('AC3: transient family → degraded-retrying with detail === code', () => {
    const BS = freshModule();
    for (const code of ['send-timeout', 'no-ack', 'transport-error:Error', 'transport-error:TypeError']) {
      const c = BS.classifySenderStatus(baseStatus({ lastError: code }));
      assert.equal(c.state, 'degraded-retrying', code);
      assert.equal(c.detail, code);
    }
  });

  it('AC4: write-failed:QuotaExceededError → failed-storage-full', () => {
    const BS = freshModule();
    const c = BS.classifySenderStatus(
      baseStatus({ lastError: 'write-failed:QuotaExceededError' }));
    assert.equal(c.state, 'failed-storage-full');
    assert.equal(c.detail, 'write-failed:QuotaExceededError');
  });

  it('AC5: other write-failed codes → failed-persistent (incl. CorruptSequenceState)', () => {
    const BS = freshModule();
    for (const code of ['write-failed:Error', 'write-failed:unavailable',
                        'write-failed:CorruptSequenceState', 'write-failed:DataError',
                        'write-failed:SomethingNew']) {
      const c = BS.classifySenderStatus(baseStatus({ lastError: code }));
      assert.equal(c.state, 'failed-persistent', code);
      assert.equal(c.detail, code);
    }
  });

  it('AC6: fail-closed — unknown non-null lastError (incl. empty string) → failed-persistent', () => {
    const BS = freshModule();
    for (const code of ['weird', '', 'TIMEOUT', 'error']) {
      const c = BS.classifySenderStatus(baseStatus({ lastError: code }));
      assert.equal(c.state, 'failed-persistent', JSON.stringify(code));
      assert.equal(c.detail, code);
    }
  });

  it('AC7: malformed input → TypeError', () => {
    const BS = freshModule();
    const bad = [null, undefined, 42, 'x', [],
      {}, // missing keys
      baseStatus({ pendingCount: '3' }),
      baseStatus({ pendingCount: NaN }),
      baseStatus({ lastError: 42 }),
      baseStatus({ transportAvailable: 'yes' }),
      baseStatus({ retryScheduled: 1 })];
    for (const b of bad) {
      assert.throws(() => BS.classifySenderStatus(b), TypeError,
        'expected TypeError for ' + JSON.stringify(b));
    }
  });
});

// ------------------------------------------------------------------
// AC8–AC9: installStatusIndicator DOM behavior.
// ------------------------------------------------------------------
describe('AC8–AC9 — installStatusIndicator', () => {
  let savedDocument;
  beforeEach(() => { savedDocument = globalThis.document; });
  afterEach(() => {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  });

  it('renders green/amber/red per state; title carries the detail code', async () => {
    const BS = freshModule();
    globalThis.document = makeFakeDocument(true);
    const sender = makeSender(baseStatus());
    const h = BS.installStatusIndicator(sender, { intervalMs: 10 });
    try {
      assert.ok(h.element.className.includes('blindfold-status-healthy'));
      assert.equal(h.element.getAttribute('title'), null);

      sender._set(baseStatus({ lastError: 'send-timeout' }));
      await sleep(40);
      assert.ok(h.element.className.includes('blindfold-status-degraded-retrying'));
      assert.equal(h.element.getAttribute('title'), 'send-timeout');

      sender._set(baseStatus({ lastError: 'write-failed:QuotaExceededError' }));
      await sleep(40);
      assert.ok(h.element.className.includes('blindfold-status-failed-storage-full'));
      assert.equal(h.element.getAttribute('title'), 'write-failed:QuotaExceededError');

      sender._set(baseStatus({ lastError: 'write-failed:CorruptSequenceState' }));
      await sleep(40);
      assert.ok(h.element.className.includes('blindfold-status-failed-persistent'));
      assert.equal(h.element.getAttribute('title'), 'write-failed:CorruptSequenceState');

      // Recovery clears: healthy again, title removed.
      sender._set(baseStatus());
      await sleep(40);
      assert.ok(h.element.className.includes('blindfold-status-healthy'));
      assert.equal(h.element.getAttribute('title'), null);
    } finally {
      h.stop();
    }
  });

  it('anchors adjacent to the move input; falls back to fixed corner', () => {
    const BS = freshModule();
    // With anchor.
    globalThis.document = makeFakeDocument(true);
    const h1 = BS.installStatusIndicator(makeSender(baseStatus()), { intervalMs: 1000 });
    try {
      const doc = globalThis.document;
      assert.equal(h1.element.parentNode, doc.input.parentNode);
      assert.ok(!h1.element.className.includes('blindfold-status-fallback'));
    } finally { h1.stop(); }

    // Without anchor → body, fallback class.
    globalThis.document = makeFakeDocument(false);
    const h2 = BS.installStatusIndicator(makeSender(baseStatus()), { intervalMs: 1000 });
    try {
      assert.equal(h2.element.parentNode, globalThis.document.body);
      assert.ok(h2.element.className.includes('blindfold-status-fallback'));
    } finally { h2.stop(); }
  });

  it('re-renders only on state/detail change (no DOM churn per poll)', async () => {
    const BS = freshModule();
    globalThis.document = makeFakeDocument(true);
    const sender = makeSender(baseStatus({ lastError: 'no-ack' }));
    const h = BS.installStatusIndicator(sender, { intervalMs: 10 });
    try {
      await sleep(50); // several polls, same state
      const setsAfterSteady = h.element._classSets;
      await sleep(50);
      assert.equal(h.element._classSets, setsAfterSteady,
        'no re-render while state/detail unchanged');
      sender._set(baseStatus({ lastError: 'send-timeout' })); // same state, new detail
      await sleep(40);
      assert.ok(h.element._classSets > setsAfterSteady,
        'detail change re-renders');
    } finally {
      h.stop();
    }
  });

  it('invalid sender → TypeError before any timer starts; invalid options → TypeError', () => {
    const BS = freshModule();
    globalThis.document = makeFakeDocument(true);
    for (const bad of [null, undefined, {}, { getStatus: 42 }]) {
      assert.throws(() => BS.installStatusIndicator(bad), TypeError);
    }
    const sender = makeSender(baseStatus());
    assert.throws(() => BS.installStatusIndicator(sender, { intervalMs: 0 }), TypeError);
    assert.throws(() => BS.installStatusIndicator(sender, { intervalMs: -5 }), TypeError);
    assert.throws(() => BS.installStatusIndicator(sender, { intervalMs: 'fast' }), TypeError);
  });

  it('a throwing getStatus never propagates; indicator keeps last state', async () => {
    const BS = freshModule();
    globalThis.document = makeFakeDocument(true);
    const sender = makeSender(baseStatus({ lastError: 'no-ack' }));
    const h = BS.installStatusIndicator(sender, { intervalMs: 10 });
    try {
      await sleep(30);
      assert.ok(h.element.className.includes('blindfold-status-degraded-retrying'));
      sender.getStatus = () => { throw new Error('boom'); };
      await sleep(50); // would throw uncaught if not swallowed
      assert.ok(h.element.className.includes('blindfold-status-degraded-retrying'),
        'keeps last rendered state');
    } finally {
      h.stop();
    }
  });

  it('AC9: default interval is 2000ms; interval injectable', () => {
    const BS = freshModule();
    assert.equal(BS.STATUS_POLL_INTERVAL_MS, 2000);
    globalThis.document = makeFakeDocument(true);
    const h = BS.installStatusIndicator(makeSender(baseStatus()), { intervalMs: 37 });
    try {
      assert.ok(h.element, 'installs with custom interval');
    } finally { h.stop(); }
    const h2 = BS.installStatusIndicator(makeSender(baseStatus()));
    try {
      assert.ok(h2.element, 'installs with default interval');
    } finally { h2.stop(); }
  });

  it('missing document → plain Error (platform capability), not TypeError', () => {
    const BS = freshModule();
    delete globalThis.document;
    assert.throws(() => BS.installStatusIndicator(makeSender(baseStatus())),
      (e) => e instanceof Error && !(e instanceof TypeError));
  });
});

// ------------------------------------------------------------------
// AC10: diff discipline. AC11: no chrome.*, no new message kinds.
// AC12: PLAN.md unmodified.
// ------------------------------------------------------------------
describe('AC10–AC12 — diff discipline and scope', () => {
  it('sender.js, writer.js, session_store.js, lifecycle.js, event_envelope.js byte-identical to HEAD (db.js legitimately changed by 4.5)', () => {
    // Honest cumulative evolution: 4.1 legitimately extends sw.js
    // (recording-context supervisor wiring) per its contract; sw.js is
    // pinned by tests/manifest_sw.test.js AC3 (4.1 cumulative) instead.
    // Honest cumulative evolution (4.5): db.js leaves this list — 4.5
    // legitimately bumps DB_VERSION 1 → 2 and adds the
    // recording_manifest store (see its pin in
    // tests/format_support.test.js).
    for (const f of ['sender.js', 'writer.js', 'session_store.js',
                     'lifecycle.js', 'event_envelope.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: ROOT, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 4.1/4.5 must not touch it`);
    }
  });

  it('manifest.json: js list carries status_indicator.js after lifecycle.js (2.8 committed)', () => {
    // Post-commit durable form of the 2.8 diff pin (2.9 repair): the working
    // tree now equals HEAD, so assert the contracted content instead of the
    // diff. (The full ordered list is pinned in tests/lifecycle.test.js.)
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const js = manifest.content_scripts[0].js;
    assert.ok(js.includes('status_indicator.js'), 'js list must include status_indicator.js');
    assert.ok(js.indexOf('lifecycle.js') < js.indexOf('status_indicator.js'),
      'status_indicator.js loads after lifecycle.js');
    assert.ok(js.indexOf('status_indicator.js') < js.indexOf('content.js'),
      'status_indicator.js loads before content.js (which installs it)');
  });

  it('content.js: the 2.8 install wiring is present exactly once (2.8 committed)', () => {
    // Post-commit durable form of the 2.8 diff pin (2.9 repair).
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    const occurrences = src.split('BlindfoldSession.installStatusIndicator(BlindfoldSession.sender);').length - 1;
    assert.strictEqual(occurrences, 1, 'content.js: exactly one 2.8 install line');
  });

  it('overlay.css: the 2.8 indicator classes are present (2.8 committed)', () => {
    // Post-commit durable form of the 2.8 diff pin (2.9 repair): assert the
    // additive classes exist in content rather than in the diff.
    const css = fs.readFileSync(path.join(ROOT, 'overlay.css'), 'utf8');
    for (const cls of ['.blindfold-status-indicator', '.blindfold-status-healthy',
                       '.blindfold-status-degraded-retrying', '.blindfold-status-failed-persistent',
                       '.blindfold-status-failed-storage-full']) {
      assert.ok(css.includes(cls), `overlay.css must define ${cls}`);
    }
  });

  it('AC11: no chrome.* in status_indicator.js; no new message kinds', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'status_indicator.js'), 'utf8');
    // Strip comments so prose mentioning chrome.* does not trip the guard.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/chrome\./.test(src), 'status_indicator.js must not use chrome.*');
    assert.ok(!/sendMessage|onMessage/.test(src), 'status_indicator.js must not add message kinds');
  });

  it('AC12: PLAN.md unmodified', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT }).toString();
    const names = execSync('git diff HEAD --name-only', { cwd: ROOT }).toString();
    assert.ok(!status.split('\n').some((l) => l.slice(3).trim() === 'PLAN.md'));
    assert.ok(!names.split('\n').some((l) => l.trim() === 'PLAN.md'));
  });

  it('no other repo files modified (git status allowlist)', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT }).toString();
    const changed = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
    const allowed = new Set([
      // Honest cumulative evolution: 4.1 (dedicated recording context)
      // legitimately adds recorder.html/recorder.js/recording_host.js,
      // the "offscreen" manifest permission, and the sw.js supervisor
      // wiring; its files join the allowlists.
      'recorder.html',
      'recorder.js',
      'recording_host.js',
      'manifest.json',
      'sw.js',
      'tests/recording_host.test.js',
      'tests/manifest_sw.test.js',
      '.autodev/evidence/4.1.contract.md',
      '.autodev/evidence/4.1.build.md',
      // Honest cumulative evolution: 4.1's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x precedent).
      '.autodev/evidence/4.1.review.md',
      '.autodev/evidence/4.1.behavior.md',
      // Honest cumulative evolution: 4.2 (microphone selection and
      // permission handling) legitimately adds device_selection.js, routes
      // the five mic commands through recorder.js/recorder.html, and adds
      // its test + evidence; its files join the allowlists.
      'device_selection.js',
      'tests/device_selection.test.js',
      '.autodev/evidence/4.2.contract.md',
      '.autodev/evidence/4.2.build.md',
      // Honest cumulative evolution: 4.2's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1 precedent).
      '.autodev/evidence/4.2.review.md',
      '.autodev/evidence/4.2.behavior.md',
      // Honest cumulative evolution: 4.3 (screen/tab capture selection
      // and permission handling) legitimately adds capture_selection.js
      // (offscreen side) + capture_broker.js (SW side), routes the four
      // capture commands plus the three SW-leg broker messages, adds the
      // tabCapture permission + host_permissions, and adds its tests +
      // evidence; its files join the allowlists.
      'capture_selection.js',
      'capture_broker.js',
      'tests/capture_selection.test.js',
      'tests/capture_broker.test.js',
      'tests/manifest_sw.test.js',
      '.autodev/evidence/4.3.contract.md',
      '.autodev/evidence/4.3.build.md',
      // Honest cumulative evolution: 4.4 (webcam selection and
      // permission handling) modifies device_selection.js (video
      // probe kind-branch + validator messages) and recorder.js
      // (camera selector + cam-* channel), and repairs
      // restoreDevices() to await all selector restores.
      '.autodev/evidence/4.4.contract.md',
      '.autodev/evidence/4.4.build.md',
      // Honest cumulative evolution: 4.4's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x/4.1-4.3 precedent).
      '.autodev/evidence/4.4.review.md',
      '.autodev/evidence/4.4.behavior.md',
      // Honest cumulative evolution: 4.5 (recording format
      // verification + recording manifest) legitimately adds
      // format_support.js, routes recorder-get-formats through
      // recorder.js/recorder.html (which now also load db.js),
      // bumps db.js to version 2 with the recording_manifest
      // store, and adds its test + evidence; its files join
      // the allowlists.
      'format_support.js',
      'db.js',
      'tests/format_support.test.js',
      '.autodev/evidence/4.5.contract.md',
      '.autodev/evidence/4.5.build.md',
      // Honest cumulative evolution: 4.5's review/behavior
      // evidence lands after the pins were evolved (2.x/3.x/4.1-4.4 precedent).
      '.autodev/evidence/4.5.review.md',
      '.autodev/evidence/4.5.behavior.md',
      // Honest cumulative evolution: 4.6 (stream start plumbing)
      // legitimately adds stream_starter.js, routes
      // recorder-start-streams through recorder.js/recorder.html, adds
      // device_selection.recordDefault, widens format_support.js's
      // recording-manifest fields, and adds its test + evidence; its
      // files join the allowlists.
      'stream_starter.js',
      'device_selection.js',
      'format_support.js',
      'recorder.js',
      'recorder.html',
      'tests/stream_starter.test.js',
      '.autodev/evidence/4.6.contract.md',
      '.autodev/evidence/4.6.build.md',
      // Honest cumulative evolution: 4.6's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.5 precedent).
      '.autodev/evidence/4.6.review.md',
      '.autodev/evidence/4.6.behavior.md',
      // Honest cumulative evolution: 4.7 (audio-content policy)
      // legitimately adds audio_policy.js, wires the classifications
      // into stream_starter.js's manifest-write stage, widens
      // format_support.js's manifest validator 13 → 15, loads the new
      // module in recorder.html, resolves it in recorder.js, records
      // the ## 4.7 decisions, and adds its test + evidence; its files
      // join the allowlists.
      'audio_policy.js',
      'tests/audio_policy.test.js',
      '.autodev/evidence/4.7.contract.md',
      '.autodev/evidence/4.7.build.md',
      // Honest cumulative evolution: 4.7's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.6 precedent).
      '.autodev/evidence/4.7.review.md',
      '.autodev/evidence/4.7.behavior.md',
      // Honest cumulative evolution: 4.8 (incremental chunk extraction)
      // legitimately adds chunk_writer.js, wires the automatic chunking
      // kickoff into recorder.js's recorder-start-streams handler, loads
      // the new module in recorder.html, records the ## 4.8 decisions,
      // and adds its test + evidence; its files join the allowlists.
      'chunk_writer.js',
      'tests/chunk_writer.test.js',
      '.autodev/evidence/4.8.contract.md',
      '.autodev/evidence/4.8.build.md',
      // Honest cumulative evolution: 4.8's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.7 precedent).
      '.autodev/evidence/4.8.review.md',
      '.autodev/evidence/4.8.behavior.md',
      // Honest cumulative evolution: 4.9 (track/error/discontinuity
      // monitoring) legitimately adds track_monitor.js, wires it into
      // recorder.js's recorder-start-streams handler (restart pre-check,
      // attach, restart events), adds the onTerminalState seam to
      // chunk_writer.js, the getManifestRecordsBySession read to
      // format_support.js, the script tag in recorder.html, records the
      // ## 4.9 decisions, and adds its test + evidence; its files join
      // the allowlists.
      'track_monitor.js',
      'tests/track_monitor.test.js',
      'tests/timecode.test.js',
      '.autodev/evidence/4.9.contract.md',
      '.autodev/evidence/4.9.build.md',
      // Honest cumulative evolution: 4.9's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.8 precedent).
      '.autodev/evidence/4.9.review.md',
      '.autodev/evidence/4.9.behavior.md',
      // Honest cumulative evolution: 4.10 (clock-segment linking)
      // legitimately adds clock_link.js, wires the link into the
      // stream starter's manifest-write stage, widens MANIFEST_KEYS
      // 15 → 16 with the 4.10-owned clockSegmentId field, adds the
      // getManifestRecord read, loads the new module in
      // recorder.html, exposes getClockLink in recorder.js (the
      // 4.13 seam), records the ## 4.10 decisions, and adds its
      // test + evidence; its files join the allowlists.
      'clock_link.js',
      'tests/clock_link.test.js',
      // 4.10 also modifies the manifest-write stage (stream_starter.js),
      // the manifest writer (format_support.js), the wiring
      // (recorder.js) and the module list (recorder.html); already
      // listed by earlier tasks where applicable — the Set dedupes.
      'stream_starter.js',
      'format_support.js',
      'recorder.js',
      'recorder.html',
      '.autodev/evidence/4.10.contract.md',
      '.autodev/evidence/4.10.build.md',
      // Honest cumulative evolution: 4.10's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.9 precedent).
      '.autodev/evidence/4.10.review.md',
      '.autodev/evidence/4.10.behavior.md',
      // Honest cumulative evolution: 4.11 (audible/visible sync
      // markers) legitimately adds sync_marker.js (offscreen audible
      // marker + SW flash-relay request), sync_flash.js (content-script
      // visible flash), sync_beep.wav (880 Hz beep asset), wires the
      // start marker into recorder.js's start-streams final .then, adds
      // the SW flash-relay leg to recording_host.js, the MSG_SYNC_FLASH
      // vocabulary entry, the script tag in recorder.html, the content
      // script in manifest.json, records the ## 4.11 decisions, and adds
      // its test + evidence; its files join the allowlists.
      'sync_marker.js',
      'sync_flash.js',
      'sync_beep.wav',
      'tests/sync_marker.test.js',
      // 4.11 also touches recorder.js, recording_host.js, recorder.html
      // and manifest.json; already listed by earlier tasks where
      // applicable — the Set dedupes.
      'recorder.js',
      'recording_host.js',
      'recorder.html',
      'manifest.json',
      '.autodev/evidence/4.11.contract.md',
      '.autodev/evidence/4.11.build.md',
      // Honest cumulative evolution: 4.11's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.10 precedent).
      '.autodev/evidence/4.11.review.md',
      '.autodev/evidence/4.11.behavior.md',
      // Honest cumulative evolution: 4.12 (recording timecode/offset
      // arithmetic) legitimately adds timecode.js (the pure nine-function
      // alignment library — media→clock→wall conversions, marker
      // disambiguation, continuity rule), persists nothing new
      // (MANIFEST_KEYS stays 16, DB_VERSION stays 2, no recorder.html
      // wiring — a library, not a pipeline stage), records the ## 4.12
      // decisions, and adds its test + evidence; its files join the
      // allowlists.
      'timecode.js',
      'tests/timecode.test.js',
      '.autodev/evidence/4.12.contract.md',
      '.autodev/evidence/4.12.build.md',
      // Honest cumulative evolution: 4.12's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.11 precedent).
      '.autodev/evidence/4.12.review.md',
      '.autodev/evidence/4.12.behavior.md',
      // Honest cumulative evolution: 4.3's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1/4.2 precedent).
      '.autodev/evidence/4.3.review.md',
      '.autodev/evidence/4.3.behavior.md',
      'status_indicator.js',
      'content.js',
      'sounds.js',
      'manifest.json',
      'overlay.css',
      'tests/status_indicator.test.js',
      // Honest cumulative evolution (2.2–2.7 precedent): earlier tasks'
      // suites pin files 2.8 legitimately touches, so their pins evolve
      // in this task's commit.
      'tests/manifest_sw.test.js',
      'tests/lifecycle.test.js',
      'tests/sender.test.js',
      'tests/writer.test.js',
      'tests/session_store.test.js',
      'tests/db.test.js',
      'tests/event_envelope.test.js',
      'tests/game_records.test.js',
      'tests/session_identity.test.js',
      '.autodev/evidence/2.8.contract.md',
      '.autodev/evidence/2.8.build.md',
      // 2.7's review NOTEs landed in DECISIONS.md after the 2.7 commit;
      // admitting the file here is honest cumulative evolution.
      '.autodev/DECISIONS.md',
      // Honest cumulative evolution: 4.13 (finalize recordings at Stop)
      // legitimately adds finalizer.js (the Stop sequence: stop-marker
      // wait, recorder stop, bounded final-flush await, device release,
      // discontinuous-segment splits, per-(sessionId, streamKind)
      // numbering, finalizedAtUtc mark), widens MANIFEST_KEYS 16 -> 18
      // with the 4.13-owned segmentNumber + finalizedAtUtc fields, adds
      // the MSG_STOP_STREAMS vocabulary entry, wires the
      // recorder-stop-streams handler into recorder.js, adds the
      // discardActiveStream seam to stream_starter.js, loads the new
      // module in recorder.html, records the ## 4.13 decisions, and adds
      // its test + evidence; its files join the allowlists.
      'finalizer.js',
      'tests/finalizer.test.js',
      'format_support.js',
      'recorder.js',
      'stream_starter.js',
      'recorder.html',
      '.autodev/evidence/4.13.contract.md',
      '.autodev/evidence/4.13.build.md',
      // Honest cumulative evolution: 4.13's review evidence lands after
      // the pins were evolved (2.x/3.x/4.1-4.12 precedent).
      '.autodev/evidence/4.13.review.md',
      // Honest cumulative evolution: the 2.8 adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.6/2.7 precedent).
      '.autodev/evidence/2.8.review.md',
      '.autodev/evidence/2.8.behavior.md',
      // Honest cumulative evolution (2.2–2.8 precedent): 2.9 adds the
      // retention scan suite (no product code) and evolves these pins.
      'tests/retention.test.js',
      '.autodev/evidence/2.9.contract.md',
      '.autodev/evidence/2.9.build.md',
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.6/2.7/2.8 precedent).
      '.autodev/evidence/2.9.review.md',
      '.autodev/evidence/2.9.behavior.md',
      // Honest cumulative evolution: 3.1 legitimately touches
      // chess_utils.js (tracker), content.js (wiring), manifest.json
      // (game_records.js for 1.4 factories), and adds the suite.
      'chess_utils.js',
      'content.js',
      'manifest.json',
      'tests/history_tracker.test.js',
      '.autodev/evidence/3.1.contract.md',
      '.autodev/evidence/3.1.build.md',
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.x precedent).
      '.autodev/evidence/3.1.review.md',
      '.autodev/evidence/3.1.behavior.md',
      // Honest cumulative evolution: 3.2's planner contract lands
      // before this task's pins evolve (3.1 precedent).
      '.autodev/evidence/3.2.contract.md',
      '.autodev/evidence/3.2.build.md',
      // Honest cumulative evolution: 3.2's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1 precedent).
      '.autodev/evidence/3.2.review.md',
      '.autodev/evidence/3.2.behavior.md',
      // Honest cumulative evolution: 3.3 legitimately touches
      // chess_utils.js + content.js; its files join the allowlists.
      'tests/visibility.test.js',
      'tests/speech.test.js',
      '.autodev/evidence/3.3.contract.md',
      '.autodev/evidence/3.3.build.md',
      // Honest cumulative evolution: 3.3's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2 precedent).
      '.autodev/evidence/3.3.review.md',
      '.autodev/evidence/3.3.behavior.md',
      '.autodev/evidence/3.3.domaudit.md',
      // Honest cumulative evolution: 3.4 legitimately touches
      // sounds.js + content.js and adds its evidence.
      '.autodev/evidence/3.4.contract.md',
      '.autodev/evidence/3.4.build.md',
      // Honest cumulative evolution: 3.4's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3 precedent).
      '.autodev/evidence/3.4.review.md',
      '.autodev/evidence/3.4.behavior.md',
      // Honest cumulative evolution: 3.5 legitimately touches
      // chess_utils.js (game lifecycle recorder + additive onGameReset
      // { confirmedMoveCount } argument) + content.js (visibility/focus
      // listeners, onGameReset recording, chess_rules game-end wiring);
      // adds tests/game_lifecycle.test.js and its evidence; records the
      // 3.5.3 dialog / reconnect audit in DECISIONS.md.
      'chess_utils.js',
      'tests/game_lifecycle.test.js',
      '.autodev/evidence/3.5.contract.md',
      '.autodev/evidence/3.5.build.md',
      // Honest cumulative evolution: 3.5's rereview/behavior
      // evidence lands after the pins were evolved (2.x/3.x precedent).
      '.autodev/evidence/3.5.rereview.md',
      '.autodev/evidence/3.5.behavior.md',
      '.autodev/DECISIONS.md',
      // Honest cumulative evolution: 4.13 (finalize recordings at Stop)
      // legitimately adds finalizer.js (the Stop sequence: stop-marker
      // wait, recorder stop, bounded final-flush await, device release,
      // discontinuous-segment splits, per-(sessionId, streamKind)
      // numbering, finalizedAtUtc mark), widens MANIFEST_KEYS 16 -> 18
      // with the 4.13-owned segmentNumber + finalizedAtUtc fields, adds
      // the MSG_STOP_STREAMS vocabulary entry, wires the
      // recorder-stop-streams handler into recorder.js, adds the
      // discardActiveStream seam to stream_starter.js, loads the new
      // module in recorder.html, records the ## 4.13 decisions, and adds
      // its test + evidence; its files join the allowlists.
      'finalizer.js',
      'tests/finalizer.test.js',
      'format_support.js',
      'recorder.js',
      'stream_starter.js',
      'recorder.html',
      '.autodev/evidence/4.13.contract.md',
      '.autodev/evidence/4.13.build.md',
      // Honest cumulative evolution: 4.13's review evidence lands after
      // the pins were evolved (2.x/3.x/4.1-4.12 precedent).
      '.autodev/evidence/4.13.review.md',
      // Honest cumulative evolution: 3.5's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3/3.4 precedent).
      '.autodev/evidence/3.5.review.md',
      '.autodev/evidence/3.5.behavior.md',
      'tests/attempt_tracker.test.js',
      // Honest cumulative evolution: 4.14 (report per-stream
      // recording status) legitimately adds stream_status.js (the
      // read-only per-stream status query over the registry, chunk
      // state, live tracks, health mirror, and manifest — no writes,
      // no events, no UI), the additive track_monitor.getStreamHealth
      // seam (+ the health mirror, nowUtcIso opt, and retention
      // calls), the recorder-get-status channel message + lazy
      // status-reader getter in recorder.js, the script tag in
      // recorder.html, records the ## 4.14 decisions, and adds its
      // test + evidence; its files join the allowlists.
      'stream_status.js',
      'tests/stream_status.test.js',
      // timecode pins tracked diffs only; track_monitor.js is the
      // tracked 4.14-modified file.
      'track_monitor.js',
      '.autodev/evidence/4.14.contract.md',
      '.autodev/evidence/4.14.build.md',
      // Honest cumulative evolution: 4.14's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.1-4.13 precedent).
      '.autodev/evidence/4.14.review.md',
      '.autodev/evidence/4.14.behavior.md',
      // Honest cumulative evolution: 5.1 (compact Start/Stop control +
      // per-stream health lights) legitimately adds session_controls.js
      // (the in-page control cluster + pure classifyStreamStatus), wires
      // the install into content.js, adds session_identity.js (ID minting)
      // and session_controls.js to the manifest content_scripts list,
      // captures ownerTabId + echoes gameId in recorder.js, adds the
      // SW-side recorder-ensure handler to recording_host.js, adds the
      // additive getLastObservedEnd getter to chess_utils.js (the Stop
      // seam for the observed game_ended reason), adds additive classes
      // to overlay.css, records the ## 5.1 decisions, and adds its test
      // + evidence; its files join the allowlists.
      'session_controls.js',
      'tests/session_controls.test.js',
      'manifest.json',
      'content.js',
      'overlay.css',
      'chess_utils.js',
      'recorder.js',
      'recording_host.js',
      '.autodev/evidence/5.1.contract.md',
      '.autodev/evidence/5.1.build.md',
      // Honest cumulative evolution: 5.1's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.x precedent).
      '.autodev/evidence/5.1.review.md',
      '.autodev/evidence/5.1.behavior.md',
      // Honest cumulative evolution: 5.2 (baseline/training/evaluation
      // selection + training approach and verbal scaffolding fields)
      // legitimately adds session_fields.js (pure buildInitialConditions +
      // UNDETECTED_CONDITION_FIELDS placeholders + installSessionFields
      // with the 5.3/5.4 seams), amends session_controls.js's Start
      // sequence (metadata-first minting, session-save, category echo,
      // category-required abort), adds the SW-side session-save handler
      // to recording_host.js, accepts/stores/echoes sessionCategory in
      // recorder.js, wires the fields install into content.js (+
      // extensionVersion pass-through), adds session_fields.js to the
      // manifest content_scripts list, adds additive classes to
      // overlay.css, records the ## 5.2 decisions, and adds its test +
      // evidence; its files join the allowlists.
      'session_fields.js',
      'tests/session_fields.test.js',
      'session_controls.js',
      'recorder.js',
      'recording_host.js',
      'content.js',
      'manifest.json',
      'overlay.css',
      '.autodev/evidence/5.2.contract.md',
      '.autodev/evidence/5.2.build.md',
      // Honest cumulative evolution: 5.2's review/behavior evidence
      // lands after the pins were evolved (2.x/3.x/4.x/5.1 precedent).
      '.autodev/evidence/5.2.review.md',
      '.autodev/evidence/5.2.behavior.md',
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });
});
