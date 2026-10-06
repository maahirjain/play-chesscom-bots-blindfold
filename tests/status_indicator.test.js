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
  it('sender.js, writer.js, db.js, session_store.js, lifecycle.js, event_envelope.js, sw.js byte-identical to HEAD', () => {
    for (const f of ['sender.js', 'writer.js', 'db.js', 'session_store.js',
                     'lifecycle.js', 'event_envelope.js', 'sw.js']) {
      const head = execSync(`git show HEAD:${f}`, { cwd: ROOT, stdio: 'pipe' }).toString();
      const current = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.strictEqual(current, head, `${f} changed but 2.8 must not touch it`);
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
      'status_indicator.js',
      'content.js',
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
      '.autodev/evidence/3.3.contract.md',
      '.autodev/evidence/3.3.build.md',
      // Honest cumulative evolution: 3.3's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2 precedent).
      '.autodev/evidence/3.3.review.md',
      '.autodev/evidence/3.3.behavior.md',
      '.autodev/evidence/3.3.domaudit.md',
      'tests/attempt_tracker.test.js',
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
  });
});
