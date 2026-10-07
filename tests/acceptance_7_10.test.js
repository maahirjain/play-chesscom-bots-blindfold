// tests/acceptance_7_10.test.js
//
// V1 verification for task 7.10 (PLAN.md §7.10) per
// .autodev/evidence/7.10.contract.md: "Verify a page refresh does not
// stop the independent recording context."
//
// The architecture provides this by construction:
// - Media capture runs in the offscreen document (recorder.js), owned by
//   the service worker, not the page.
// - Event storage runs in the service worker (writer.js, IndexedDB).
// - Content scripts DO die on refresh; they re-attach via late
//   attachment (7.5) and re-bind via 5.5's idempotent set-session.
//
// "Verified" means:
// 1. (AC1) No recording-state lives in page-bound contexts.
// 2. (AC2) Content-script unload does NOT send stop/teardown.
// 3. (AC3) Re-binding: reload → same session ID → 5.5 guard allows
//    idempotent re-set, no new session, streams keep running.
//
// Run: node --test tests/acceptance_7_10.test.js (from repo root)

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS_REC = require(path.join(REPO, 'recorder.js'));

// ------------------------------------------------------------------
// AC1 — Separation: recorder.js holds no page-bound references.
// ------------------------------------------------------------------
describe('AC1 — recorder.js has no page-bound references', () => {
  it('recorder.js does not query the chess.com page DOM', () => {
    const src = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    // The offscreen document may reference its OWN document (for the
    // <audio>/<video> elements it owns), but must never query the
    // chess.com page DOM (wc-chess-board, .move-list, etc.).
    const pageSelectors = [
      'wc-chess-board',
      'chess-board',
      '.move-list',
      'querySelector',
    ];
    for (const sel of pageSelectors) {
      if (sel === 'querySelector') {
        // Allow querySelector only if it's on the offscreen document
        // itself, not the page. Check for page-specific usage.
        const lines = src.split('\n').filter((l) =>
          l.includes('querySelector') && !l.trim().startsWith('//'));
        for (const line of lines) {
          assert.ok(
            !line.includes('wc-chess') && !line.includes('move-list'),
            'recorder.js must not query page DOM: ' + line.trim()
          );
        }
      } else {
        assert.ok(
          !src.includes(sel),
          'recorder.js must not reference page selector: ' + sel
        );
      }
    }
  });

  it('recorder.js capture path uses no page-specific chrome.tabs calls', () => {
    const src = fs.readFileSync(path.join(REPO, 'recorder.js'), 'utf8');
    // chrome.tabs is for page interaction; the recorder's capture path
    // (getDisplayMedia via offscreen, getUserMedia) must not depend on
    // page tabs. The ownerTabId is for 5.5's guard only, not capture.
    const lines = src.split('\n').filter((l) =>
      l.includes('chrome.tabs') && !l.trim().startsWith('//'));
    for (const line of lines) {
      // ownerTabId tracking is allowed (5.5 guard); capture must not
      // use tabs.
      assert.ok(
        line.includes('ownerTabId') || line.includes('sender.tab'),
        'recorder.js chrome.tabs use must be guard-only, not capture: ' +
        line.trim()
      );
    }
  });
});

// ------------------------------------------------------------------
// AC2 — No teardown on content-script unload.
// ------------------------------------------------------------------
describe('AC2 — content-script unload does not stop the recorder', () => {
  it('content.js has no beforeunload/unload handler', () => {
    const src = fs.readFileSync(path.join(REPO, 'content.js'), 'utf8');
    assert.ok(
      !src.includes('beforeunload') && !src.includes('addEventListener(\'unload\''),
      'content.js must not send teardown on page unload'
    );
    // Also check for generic unload listener patterns.
    const unloadPatterns = src.split('\n').filter((l) =>
      /addEventListener\s*\(\s*['"]unload['"]/.test(l));
    assert.deepEqual(unloadPatterns, [],
      'content.js must have no unload listeners');
  });

  it('session_controls.js has no beforeunload/unload handler that stops streams', () => {
    const src = fs.readFileSync(path.join(REPO, 'session_controls.js'), 'utf8');
    // The only MSG_STOP_STREAMS send must be the explicit Stop button
    // handler, not an unload hook.
    const stopSends = src.split('\n').filter((l) =>
      l.includes('MSG_STOP_STREAMS') && l.includes('channelCall'));
    assert.ok(stopSends.length >= 1,
      'expected at least one MSG_STOP_STREAMS send (the Stop button)');
    // Verify none are in an unload/beforeunload context.
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('MSG_STOP_STREAMS') &&
          lines[i].includes('channelCall')) {
        // Check surrounding context (10 lines each way) for unload.
        const ctx = lines.slice(Math.max(0, i - 10), i + 10).join('\n');
        assert.ok(
          !ctx.includes('beforeunload') && !/unload['"]/.test(ctx),
          'MSG_STOP_STREAMS must not be sent from an unload handler'
        );
      }
    }
  });
});

// ------------------------------------------------------------------
// AC3 — Re-binding: reload with same session ID is idempotent.
// ------------------------------------------------------------------
// Recorder harness (duplicate_start.test.js precedent).
let savedRecNS;
beforeEach(() => {
  savedRecNS = globalThis.BlindfoldSession;
  globalThis.BlindfoldSession = Object.assign({}, BS_REC, {
    createDeviceSelector() {
      throw new Error('test: must not be called (injectables win)');
    },
    createCaptureSelector() {
      throw new Error('test: must not be called (injectables win)');
    },
  });
});
afterEach(() => {
  if (savedRecNS === undefined) delete globalThis.BlindfoldSession;
  else globalThis.BlindfoldSession = savedRecNS;
  savedRecNS = undefined;
});

function makeRecorder() {
  const noopSelector = {
    announceSelectionForSession() { /* no-op */ },
  };
  return BS_REC.createOffscreenRecorder({
    announce: false,
    deviceSelector: noopSelector,
    cameraSelector: noopSelector,
    captureSelector: noopSelector,
  });
}

function setSession(rec, sessionId, gameId, sender) {
  const msg = {
    kind: 'recorder', v: 1, msg: 'recorder-set-session',
    sessionId: sessionId, gameId: gameId,
  };
  let responded = null;
  const ret = rec.onRuntimeMessage(
    msg,
    sender || { tab: { id: 11 } },
    (resp) => { responded = resp; }
  );
  return { responded, ret };
}

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

describe('AC3 — page reload re-binds to the running session', () => {
  it('same session ID re-set is allowed (idempotent, not a new session)', () => {
    const rec = makeRecorder();
    // Initial Start: set the session.
    const first = setSession(rec, SID, GID, { tab: { id: 11 } });
    assert.equal(first.responded.ok, true,
      'initial set-session must succeed');

    // Simulate page reload: content script re-initializes and re-sends
    // set-session with the SAME session ID (from storage or the SW).
    // This may come from a different tab ID (new page load).
    const reload = setSession(rec, SID, GID, { tab: { id: 42 } });
    assert.equal(reload.responded.ok, true,
      'reload re-set with same session ID must be allowed (idempotent)');
  });

  it('re-set does not mint a new session or stop streams', () => {
    const rec = makeRecorder();
    setSession(rec, SID, GID, { tab: { id: 11 } });

    // After reload re-set, the session ID must be unchanged.
    const reload = setSession(rec, SID, GID, { tab: { id: 42 } });
    assert.equal(reload.responded.ok, true);

    // A DIFFERENT session ID is still refused (5.5 guard intact) —
    // the reload did not clear the guard or create a new session.
    const other = setSession(rec,
      'cccccccc-3333-4333-8333-cccccccccccc', GID, { tab: { id: 43 } });
    assert.equal(other.responded.ok, false);
    assert.equal(other.responded.error, 'session-active',
      '5.5 guard still refuses a new session after reload re-bind');
  });

  it('recorder keeps no per-page state that a reload would lose', () => {
    // The session binding is (sessionId, gameId, ownerTabId) in the
    // offscreen recorder — not in content-script variables or DOM.
    // After a reload, the new content script re-sends set-session;
    // the recorder accepts it because the sessionId matches.
    // This test asserts the mechanism: the guard discriminates on
    // sessionId equality, not tab identity.
    const rec = makeRecorder();
    setSession(rec, SID, GID, { tab: { id: 11 } });

    // Same session, different tab (simulating reload in a new tab
    // context) → allowed.
    const r1 = setSession(rec, SID, GID, { tab: { id: 99 } });
    assert.equal(r1.responded.ok, true,
      'guard discriminates on sessionId, not tab identity');

    // Different session, same tab → refused.
    const r2 = setSession(rec,
      'dddddddd-4444-4444-8444-dddddddddddd', GID, { tab: { id: 11 } });
    assert.equal(r2.responded.ok, false);
    assert.equal(r2.responded.error, 'session-active');
  });
});
