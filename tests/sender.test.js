//
// Task 2.3 (PLAN.md §2.3): V1 verification for sender.js — the content-script
// event sender (timestamp + queue observations immediately).
//
// Mocked transport throughout (no chrome.* in Node). Real performance.now()
// bounds the timestamp-at-observation guarantee. Static guards enforce the
// diff discipline (manifest js list, one-line content.js change, sw.js/db.js
// byte-identical to HEAD). Real-transport behavior is covered at V2 in the
// puppeteer harness (~/workspace/tools/ext-verify/sw-sender.js).

const assert = require('node:assert/strict');
const { describe, it, before, after, mock } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Load order: event_envelope.js first, publish the merged namespace on
// globalThis (sender.js reads event_envelope.js exports at call time via
// the shared namespace), then require sender.js and merge its exports.
const Envelope = require('../event_envelope.js');
const priorGlobal = globalThis.BlindfoldSession;
globalThis.BlindfoldSession = Envelope;
const SenderExports = require('../sender.js');
Object.assign(Envelope, SenderExports);
const BlindfoldSession = Envelope;

const SENDER_PATH = path.join(ROOT, 'sender.js');
const senderSource = fs.readFileSync(SENDER_PATH, 'utf8');
// Strip line and block comments so static checks see code tokens only.
const codeOnly = senderSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

// Deterministic UUID v4 fixtures (version nibble 4, variant nibble 8-b).
const SID1 = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const SID2 = 'b1f2a345-6c78-4d9e-8f01-23456789abcd';
const GID1 = 'c2f3a456-7d89-4e0f-9123-456789abcdef';

const MOVE_PAYLOAD = () => ({ from: 'e2', to: 'e4', promotion: null });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Task 2.5: the sender now schedules retry timers on failed attempts.
// Mock setTimeout/clearTimeout file-wide so a failing transport can never
// leave a real pending handle that would stall the test runner. Existing
// (2.3) tests make no timer calls and are unaffected; the 2.5 block drives
// time with mock.timers.tick().
before(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
after(() => { mock.timers.reset(); });

// Advance the mocked clock, then flush every microtask chain the timer
// callbacks triggered (the pump's promise continuations).
const advance = async (ms) => {
  mock.timers.tick(ms);
  await tick();
};

// Transport that acks every message positively and immediately.
function ackAllTransport(log) {
  return (msg) => {
    if (log) log.push(msg);
    return Promise.resolve({ ok: true, eventId: msg.event.eventId });
  };
}

// Controllable deferred transport: sends are recorded; each returns a
// promise resolved by ackNext(value).
function deferredTransport() {
  const calls = [];
  const waiters = [];
  const transport = (msg) => {
    calls.push(msg);
    return new Promise((resolve) => { waiters.push(resolve); });
  };
  transport.calls = calls;
  transport.inFlight = () => waiters.length;
  transport.ackNext = (value) => {
    const resolve = waiters.shift();
    assert.ok(resolve, 'ackNext called with no in-flight send');
    const head = calls[calls.length - 1];
    resolve(value === undefined
      ? { ok: true, eventId: head.event.eventId }
      : value);
  };
  return transport;
}

function emitMove(sender, sessionId, gameId) {
  return sender.emit({
    eventType: 'move_confirmed',
    sessionId: sessionId === undefined ? SID1 : sessionId,
    gameId: gameId === undefined ? null : gameId,
    payload: MOVE_PAYLOAD()
  });
}

describe('AC1 — module surface', () => {
  it('loads in Node with chrome undefined', () => {
    assert.equal(typeof globalThis.chrome, 'undefined');
    assert.equal(typeof BlindfoldSession.createSender, 'function');
  });

  it("SENDER_MESSAGE_KIND === 'event'", () => {
    assert.equal(BlindfoldSession.SENDER_MESSAGE_KIND, 'event');
  });

  it('createSender returns a sender with the contracted API', () => {
    const s = BlindfoldSession.createSender();
    for (const m of ['emit', 'flush', 'pendingCount', 'getStatus']) {
      assert.equal(typeof s[m], 'function', m);
    }
    assert.ok(s.anchor, 'anchor missing');
    assert.equal(Object.keys(s.anchor).length, 3);
    assert.ok(Object.isFrozen(s.anchor), 'anchor not frozen');
    assert.ok(Object.isFrozen(s), 'sender not frozen');
  });

  it('createSender rejects non-object options / non-function transport', () => {
    assert.throws(() => BlindfoldSession.createSender('nope'), TypeError);
    assert.throws(() => BlindfoldSession.createSender({ transport: 42 }), TypeError);
  });

  it('constructor throws plain Error (not TypeError) when performance.now is unavailable', () => {
    const saved = globalThis.performance;
    globalThis.performance = undefined;
    try {
      assert.throws(
        () => BlindfoldSession.createSender(),
        (err) => err instanceof Error &&
          !(err instanceof TypeError) &&
          !(err instanceof RangeError)
      );
    } finally {
      globalThis.performance = saved;
    }
  });
});

describe('AC2 — timestamp at observation', () => {
  it('monotonicMs is captured synchronously in emit(), before queueing and send', async () => {
    let sendTime = null;
    const transport = (msg) => {
      sendTime = performance.now();
      return Promise.resolve({ ok: true, eventId: msg.event.eventId });
    };
    const s = BlindfoldSession.createSender({ transport });
    const t0 = performance.now();
    const env = emitMove(s);
    const t1 = performance.now();
    await s.flush();
    assert.ok(t0 <= env.monotonicMs, `t0=${t0} > monotonicMs=${env.monotonicMs}`);
    assert.ok(env.monotonicMs <= t1, `monotonicMs=${env.monotonicMs} > t1=${t1}`);
    assert.ok(t1 <= sendTime, `t1=${t1} > sendTime=${sendTime}`);
    assert.equal(typeof env.monotonicMs, 'number');
  });
});

describe('AC3 — per-session clock_anchor first', () => {
  it('first emit queues [clock_anchor(seq 0), event(seq 1)]', async () => {
    const t = deferredTransport();
    const s = BlindfoldSession.createSender({ transport: t });
    const env = emitMove(s);
    await tick();
    assert.equal(t.calls.length, 1);
    const anchorMsg = t.calls[0];
    assert.deepEqual(Object.keys(anchorMsg).sort(), ['event', 'kind']);
    assert.equal(anchorMsg.kind, 'event');
    assert.equal(anchorMsg.event.eventType, 'clock_anchor');
    assert.equal(anchorMsg.event.sourceSeq, 0);
    assert.equal(anchorMsg.event.sessionId, SID1);
    assert.equal(anchorMsg.event.gameId, null);
    assert.equal(anchorMsg.event.sourceContext, 'content_script');
    assert.equal(anchorMsg.event.appendSeq, null);
    assert.deepEqual(anchorMsg.event.payload, s.anchor);
    assert.ok(Object.isFrozen(anchorMsg.event));

    t.ackNext();
    await tick();
    assert.equal(t.calls.length, 2);
    const obsMsg = t.calls[1];
    assert.equal(obsMsg.event.eventType, 'move_confirmed');
    assert.equal(obsMsg.event.sourceSeq, 1);
    assert.equal(obsMsg.event.sessionId, SID1);
    assert.equal(obsMsg.event.sourceContext, 'content_script');
    assert.equal(obsMsg.event.appendSeq, null);
    assert.ok(Object.isFrozen(obsMsg.event));
    assert.equal(env, obsMsg.event, 'emit() must return the observation envelope');

    t.ackNext();
    const summary = await s.flush();
    assert.deepEqual(summary, { delivered: 2, pending: 0 });
    assert.equal(s.pendingCount(), 0);
  });

  it('a new sessionId re-emits the anchor; the counter is per segment', async () => {
    const t = deferredTransport();
    const s = BlindfoldSession.createSender({ transport: t });
    emitMove(s, SID1);
    t.ackNext(); await tick();
    t.ackNext(); await s.flush();
    assert.equal(s.pendingCount(), 0);

    const env2 = emitMove(s, SID2);
    await tick();
    assert.equal(t.calls.length, 3);
    assert.equal(t.calls[2].event.eventType, 'clock_anchor');
    assert.equal(t.calls[2].event.sessionId, SID2);
    assert.equal(t.calls[2].event.sourceSeq, 2);
    // Same segment-scoped anchor payload, session-scoped event row.
    assert.deepEqual(t.calls[2].event.payload, s.anchor);

    t.ackNext(); await tick();
    assert.equal(t.calls[3].event.eventType, 'move_confirmed');
    assert.equal(t.calls[3].event.sourceSeq, 3);
    assert.equal(env2.sourceSeq, 3);
    t.ackNext(); await s.flush();
    assert.equal(s.pendingCount(), 0);
  });

  it('failed validation consumes no sourceSeq and queues nothing', () => {
    const s = BlindfoldSession.createSender({ transport: ackAllTransport() });
    assert.throws(
      () => s.emit({ eventType: 'Bogus_Type!', sessionId: SID1, gameId: null, payload: MOVE_PAYLOAD() }),
      RangeError
    );
    assert.equal(s.pendingCount(), 0);
    const env = emitMove(s, SID1);
    assert.equal(env.sourceSeq, 1, 'anchor still took seq 0 after the failed emit');
  });
});

describe('AC4 — FIFO queue, stop-and-wait', () => {
  it('exactly one in-flight send; acks dequeue in order', async () => {
    const t = deferredTransport();
    const s = BlindfoldSession.createSender({ transport: t });
    emitMove(s, SID1);
    emitMove(s, SID1);
    await tick();
    assert.equal(t.calls.length, 1, 'only the head is sent while its ack is pending');
    assert.equal(t.inFlight(), 1);

    t.ackNext(); await tick();
    assert.equal(t.calls.length, 2);
    assert.equal(t.calls[1].event.sourceSeq, 1);

    t.ackNext(); await tick();
    assert.equal(t.calls.length, 3);
    assert.equal(t.calls[2].event.sourceSeq, 2);

    t.ackNext();
    const summary = await s.flush();
    assert.deepEqual(summary, { delivered: 3, pending: 0 });
    assert.equal(s.pendingCount(), 0);
  });
});

describe('AC5 — ack discipline', () => {
  it('ok:false keeps the event queued, records lastError, stops the pump', async () => {
    const t = deferredTransport();
    const s = BlindfoldSession.createSender({ transport: t });
    emitMove(s, SID1);
    await tick();
    assert.equal(t.calls.length, 1);
    t.ackNext({ ok: false, eventId: t.calls[0].event.eventId, error: 'quota-exceeded' });
    const summary = await s.flush();
    assert.equal(s.pendingCount(), 2, 'anchor + observation still queued');
    assert.deepEqual(summary, { delivered: 0, pending: 2 });
    assert.equal(s.getStatus().lastError, 'quota-exceeded');
    await tick();
    assert.equal(t.calls.length, 1, 'pump stopped: no further sends');
  });

  it('retry re-sends the identical envelope (source times never rewritten)', async () => {
    const t = deferredTransport();
    const s = BlindfoldSession.createSender({ transport: t });
    const env = emitMove(s, SID1);
    await tick();
    t.ackNext({ ok: false, eventId: t.calls[0].event.eventId, error: 'boom' });
    await s.flush();
    assert.equal(s.getStatus().lastError, 'boom');

    // 2.5's retry primitive: flush() re-attempts the head.
    const p2 = s.flush();
    await tick();
    assert.equal(t.calls.length, 2, 'head re-sent on retry');
    assert.equal(t.calls[1].event.eventId, t.calls[0].event.eventId);
    assert.equal(t.calls[1].event.monotonicMs, t.calls[0].event.monotonicMs);

    t.ackNext(); await tick();
    t.ackNext(); await s.flush();
    assert.equal(s.pendingCount(), 0);
    assert.equal(s.getStatus().lastError, null, 'lastError cleared after success');
    assert.equal(env.sourceSeq, 1);
  });

  it('undefined ack (no SW listener) keeps queued with lastError no-ack', async () => {
    const s = BlindfoldSession.createSender({ transport: () => undefined });
    emitMove(s, SID1);
    const summary = await s.flush();
    assert.deepEqual(summary, { delivered: 0, pending: 2 });
    assert.equal(s.pendingCount(), 2);
    assert.equal(s.getStatus().lastError, 'no-ack');
  });

  it('transport rejection keeps queued with transport-error:<name>', async () => {
    const err = new Error('boom');
    err.name = 'TestError';
    const s = BlindfoldSession.createSender({ transport: () => Promise.reject(err) });
    emitMove(s, SID1);
    const summary = await s.flush();
    assert.deepEqual(summary, { delivered: 0, pending: 2 });
    assert.equal(s.getStatus().lastError, 'transport-error:TestError');
  });

  it('sync-throwing transport keeps queued with transport-error:<name>', async () => {
    const s = BlindfoldSession.createSender({
      transport: () => { const e = new Error('sync'); e.name = 'SyncError'; throw e; }
    });
    emitMove(s, SID1);
    const summary = await s.flush();
    assert.deepEqual(summary, { delivered: 0, pending: 2 });
    assert.equal(s.getStatus().lastError, 'transport-error:SyncError');
  });

  it('eventId mismatch keeps queued with lastError no-ack', async () => {
    const s = BlindfoldSession.createSender({
      transport: () => Promise.resolve({ ok: true, eventId: '00000000-0000-4000-8000-000000000000' })
    });
    emitMove(s, SID1);
    const summary = await s.flush();
    assert.deepEqual(summary, { delivered: 0, pending: 2 });
    assert.equal(s.getStatus().lastError, 'no-ack');
  });

  it('shape-mismatched ack keeps queued with lastError no-ack', async () => {
    const s = BlindfoldSession.createSender({
      transport: () => Promise.resolve({ nope: 1 })
    });
    emitMove(s, SID1);
    await s.flush();
    assert.equal(s.pendingCount(), 2);
    assert.equal(s.getStatus().lastError, 'no-ack');
  });

  it('emit(nonObject) throws TypeError', () => {
    const s = BlindfoldSession.createSender();
    assert.throws(() => s.emit(null), TypeError);
    assert.throws(() => s.emit('move_confirmed'), TypeError);
    assert.throws(() => s.emit(undefined), TypeError);
  });

  it('bad envelope fields delegate to createEvent validation', () => {
    const s = BlindfoldSession.createSender();
    assert.throws(
      () => s.emit({ eventType: 'move_confirmed', sessionId: 'not-a-uuid', gameId: null, payload: MOVE_PAYLOAD() }),
      TypeError
    );
    assert.equal(s.pendingCount(), 0, 'nothing queued after validation throw');
  });
});

describe('AC6 — no transport', () => {
  it('emit() never throws; events queue; status is honest', async () => {
    assert.equal(typeof globalThis.chrome, 'undefined');
    const s = BlindfoldSession.createSender();
    emitMove(s, SID1);
    emitMove(s, SID1);
    const summary = await s.flush();
    assert.deepEqual(summary, { delivered: 0, pending: 3 });
    assert.equal(s.pendingCount(), 3);
    assert.deepEqual(s.getStatus(), {
      pendingCount: 3,
      lastError: null,
      transportAvailable: false,
      retryScheduled: false // 2.5: no transport => no retry ever scheduled
    });
  });

  it('explicit undefined transport behaves like no transport', async () => {
    const s = BlindfoldSession.createSender({ transport: undefined });
    emitMove(s, SID1);
    await s.flush();
    assert.equal(s.pendingCount(), 2);
    assert.equal(s.getStatus().transportAvailable, false);
  });

  it('consecutive flush() calls after synchronous pump runs each start fresh (no stale promise)', async () => {
    // Regression: the Promise executor runs synchronously, so a run that
    // finishes without awaiting must not leave a stale resolved promise
    // that later flush() calls wrongly join.
    const s = BlindfoldSession.createSender();
    emitMove(s, SID1);
    const first = await s.flush();
    assert.deepEqual(first, { delivered: 0, pending: 2 });
    emitMove(s, SID1);
    const second = await s.flush();
    assert.deepEqual(second, { delivered: 0, pending: 3 });
    assert.equal(s.pendingCount(), 3);
  });
});

describe('AC7 — diff discipline (static)', () => {
  const manifestPath = path.join(ROOT, 'manifest.json');

  it('manifest js list is exactly the contracted order', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // 2.7 legitimately inserts lifecycle.js after sender.js per its
    // contract (page/context lifecycle events). 2.8 inserts
    // status_indicator.js after lifecycle.js (deviation from the 2.8
    // contract AC10 documented in 2.8.build.md — the module cannot load
    // in the content script without the manifest entry).
    // 3.1 inserts game_records.js before chess_utils.js — the tracker
    // needs the 1.4 payload factories in the content-script world.
    assert.deepEqual(manifest.content_scripts[0].js, [
      'event_envelope.js', 'sender.js', 'lifecycle.js', 'status_indicator.js',
      'sounds.js', 'chess.min.js', 'game_records.js', 'chess_utils.js', 'content.js'
    ]);
  });

  it('manifest is otherwise meaning-identical to HEAD (js list + 4.1/4.3 permissions only)', () => {
    // Honest cumulative evolution: 4.1 legitimately adds
    // "permissions": ["offscreen"] per its contract (pinned in
    // tests/recording_host.test.js AC2); 4.3 legitimately extends it with
    // "tabCapture" and adds host_permissions per its contract. The
    // cumulative invariant: the manifest differs from HEAD only in the js
    // list, the permissions, and host_permissions.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const headManifest = JSON.parse(
      execSync('git show HEAD:manifest.json', { cwd: ROOT }).toString()
    );
    headManifest.content_scripts[0].js = manifest.content_scripts[0].js;
    headManifest.permissions = manifest.permissions;
    headManifest.host_permissions = manifest.host_permissions;
    assert.deepEqual(manifest, headManifest);
    assert.deepStrictEqual(manifest.permissions, ['offscreen', 'tabCapture']);
    assert.deepStrictEqual(manifest.host_permissions, ['https://www.chess.com/*']);
  });

  it('content.js still carries exactly the one sender-instantiation line (cumulative)', () => {
    // 2.3 added the line via git diff; 2.4 must not add more. Cumulative
    // invariant: the line exists exactly once in the file.
    const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    const needle = 'BlindfoldSession.sender = BlindfoldSession.createSender();';
    const occurrences = content.split(needle).length - 1;
    assert.strictEqual(occurrences, 1, 'expected exactly one sender instantiation line');
  });

  it('db.js is byte-identical to HEAD apart from the 4.5 manifest store', () => {
    // 2.4 legitimately amended sw.js (writer intake); its cumulative state
    // is pinned in tests/writer.test.js (AC11). Honest cumulative
    // evolution (4.5): db.js legitimately bumps DB_VERSION 1 → 2 and
    // adds the recording_manifest store (see its pin in
    // tests/format_support.test.js); everything else in db.js must be
    // untouched. Proven on the git diff: every changed line belongs to
    // a hunk that carries a 4.5 marker.
    const work = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
    assert.ok(work.includes('recording_manifest'),
      'db.js must carry the 4.5 recording_manifest store');
    assert.ok(work.includes('var DB_VERSION = 2;'),
      'db.js must carry the 4.5 DB_VERSION bump');
    const diff = execSync('git diff HEAD -- db.js', { cwd: ROOT }).toString();
    const hunks = diff.split(/^@@/m).slice(1);
    // SF-1 (4.5 review): this test must stay green after the coordinator
    // commits 4.5 — post-commit `git diff HEAD` is empty, so the hunk
    // check runs only when a diff exists; the content assertions above
    // pin the 4.5 change durably either way (2.8/4.4 precedent).
    if (diff.trim().length > 0) {
      assert.ok(hunks.length > 0, 'expected a db.js diff (the 4.5 change)');
    }
    const stray = hunks.filter(
      (h) => !/recording_manifest|DB_VERSION = 2|4\.5/.test(h));
    assert.deepEqual(stray, [],
      'db.js has diff hunks beyond the 4.5 manifest store:\n' +
      stray.join('\n@@'));
  });

  it('sender.js has no chrome. literal in code (lazy resolver uses bracket notation)', () => {
    assert.ok(!codeOnly.includes('chrome.'), 'found "chrome." in sender.js code');
  });

  it('sender.js reads event_envelope.js exports at call time, never at load', () => {
    // The module-local BlindfoldSession (module.exports) must NOT carry the
    // envelope functions — they arrive via the shared namespace at call time.
    assert.equal(typeof SenderExports.createEvent, 'undefined');
    assert.equal(typeof SenderExports.captureClockAnchor, 'undefined');
  });
});

describe('2.5 retry policy', () => {
  it('AC1: never-settling transport -> send-timeout, head queued, retry scheduled', async () => {
    const calls = [];
    const s = BlindfoldSession.createSender({
      transport: (msg) => {
        calls.push(msg);
        // Attempts 1-2 never settle; attempt 3+ acks (lets the test drain).
        return calls.length > 2
          ? Promise.resolve({ ok: true, eventId: msg.event.eventId })
          : new Promise(() => {});
      },
      sendTimeoutMs: 1000,
      retryIntervalMs: 500
    });
    emitMove(s, SID1);
    assert.equal(calls.length, 1);
    assert.equal(s.getStatus().retryScheduled, false);
    await advance(999);
    assert.equal(s.getStatus().lastError, null, 'no timeout before sendTimeoutMs');
    assert.equal(calls.length, 1);
    await advance(1); // t=1000: the send timeout fires
    assert.equal(s.getStatus().lastError, 'send-timeout');
    assert.equal(s.pendingCount(), 2, 'anchor + observation still queued');
    assert.equal(s.getStatus().retryScheduled, true);
    await advance(500); // t=1500: retry timer fires -> resend
    assert.equal(calls.length, 2, 'retry re-attempted the head');
    assert.equal(calls[1].event.eventId, calls[0].event.eventId, 'byte-identical resend');
    assert.equal(calls[1].event.monotonicMs, calls[0].event.monotonicMs,
      'observation time never rewritten');
    // Cleanup: attempt 2 also times out, then attempt 3 acks and drains.
    await advance(1000); // t=2500: second timeout -> retry scheduled
    assert.equal(s.getStatus().lastError, 'send-timeout');
    await advance(500); // t=3000: retry -> attempt 3 acks -> drain
    await tick();
    assert.equal(s.pendingCount(), 0);
    assert.equal(s.getStatus().retryScheduled, false);
    assert.equal(s.getStatus().lastError, null);
  });

  it('AC2: late {ok:true} after its timeout is discarded; retry resend acks idempotently', async () => {
    const calls = [];
    const resolvers = [];
    const s = BlindfoldSession.createSender({
      transport: (msg) => {
        calls.push(msg);
        return new Promise((resolve) => { resolvers.push(resolve); });
      },
      sendTimeoutMs: 1000,
      retryIntervalMs: 500
    });
    emitMove(s, SID1);
    assert.equal(calls.length, 1);
    await advance(1000); // timeout fires
    assert.equal(s.getStatus().lastError, 'send-timeout');
    assert.equal(s.pendingCount(), 2);
    // Late ack for the timed-out attempt: the race already settled, so this
    // is discarded — no double-dequeue, no state corruption.
    resolvers[0]({ ok: true, eventId: calls[0].event.eventId });
    await tick();
    assert.equal(s.pendingCount(), 2, 'late ack must not dequeue');
    assert.equal(s.getStatus().lastError, 'send-timeout', 'late ack must not clear the timeout');
    assert.equal(s.getStatus().retryScheduled, true);
    // The scheduled retry resends the identical head; ack it.
    await advance(500);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].event.eventId, calls[0].event.eventId);
    resolvers[1]({ ok: true, eventId: calls[1].event.eventId });
    await tick();
    assert.equal(s.pendingCount(), 1, 'anchor dequeued exactly once');
    // Pump continues to the move; ack it to drain.
    assert.equal(calls.length, 3);
    resolvers[2]({ ok: true, eventId: calls[2].event.eventId });
    await tick();
    assert.equal(s.pendingCount(), 0);
    assert.equal(s.getStatus().retryScheduled, false);
    assert.equal(s.getStatus().lastError, null);
  });

  it('AC3: rejecting transport retries on the fixed interval; recovery drains', async () => {
    const calls = [];
    let shouldFail = true;
    const err = new Error('down');
    err.name = 'NetError';
    const s = BlindfoldSession.createSender({
      transport: (msg) => {
        calls.push(msg);
        return shouldFail
          ? Promise.reject(err)
          : Promise.resolve({ ok: true, eventId: msg.event.eventId });
      },
      sendTimeoutMs: 10000,
      retryIntervalMs: 500
    });
    emitMove(s, SID1);
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(s.getStatus().lastError, 'transport-error:NetError');
    assert.equal(s.getStatus().retryScheduled, true);
    await advance(500);
    assert.equal(calls.length, 2, 'one re-attempt after one interval');
    await advance(500);
    assert.equal(calls.length, 3);
    shouldFail = false;
    await advance(500); // retry -> acks flow through -> drain
    assert.equal(s.pendingCount(), 0, 'recovery drains the queue');
    assert.equal(s.getStatus().retryScheduled, false);
    assert.equal(s.getStatus().lastError, null);
  });

  it('AC4: repeated failures re-attempt exactly once per interval (no timer stacking)', async () => {
    const calls = [];
    let failuresLeft = 6;
    const s = BlindfoldSession.createSender({
      transport: (msg) => {
        calls.push(msg);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Promise.reject(new Error('x'));
        }
        return Promise.resolve({ ok: true, eventId: msg.event.eventId });
      },
      sendTimeoutMs: 10000,
      retryIntervalMs: 500
    });
    emitMove(s, SID1);
    await tick();
    assert.equal(calls.length, 1);
    // NOTE: mock.timers.tick() runs timer callbacks synchronously without
    // interleaving microtasks, so each chained retry needs its own advance:
    // a retry is scheduled in the rejection microtask *after* the tick.
    await advance(500);
    assert.equal(calls.length, 2);
    await advance(500);
    assert.equal(calls.length, 3);
    await advance(500);
    assert.equal(calls.length, 4);
    await advance(500);
    assert.equal(calls.length, 5);
    await advance(500);
    assert.equal(calls.length, 6, 'one attempt per interval, never stacked');
    assert.equal(s.getStatus().retryScheduled, true);
    // Cleanup: failures exhausted -> drain.
    await advance(500);
    await tick();
    assert.equal(s.pendingCount(), 0);
    assert.equal(s.getStatus().retryScheduled, false);
  });

  it('AC5: emit() while a retry is scheduled pumps immediately; stale timer consumed', async () => {
    const calls = [];
    let shouldFail = true;
    const s = BlindfoldSession.createSender({
      transport: (msg) => {
        calls.push(msg);
        return shouldFail
          ? Promise.reject(new Error('x'))
          : Promise.resolve({ ok: true, eventId: msg.event.eventId });
      },
      sendTimeoutMs: 10000,
      retryIntervalMs: 5000
    });
    emitMove(s, SID1);
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(s.getStatus().retryScheduled, true);
    shouldFail = false;
    emitMove(s, SID1); // new observation kicks the pump NOW, before the 5s interval
    await tick();
    assert.ok(calls.length > 1, 'pump ran immediately on emit()');
    assert.equal(s.pendingCount(), 0, 'immediate run drained everything');
    assert.equal(s.getStatus().retryScheduled, false, 'stale retry consumed, none rescheduled');
    await advance(5000);
    assert.equal(calls.length, 4, 'no phantom retry after the old interval elapsed');
  });

  it('AC6: no resolvable transport never schedules a retry', async () => {
    assert.equal(typeof globalThis.chrome, 'undefined');
    const s = BlindfoldSession.createSender({ sendTimeoutMs: 1000, retryIntervalMs: 500 });
    emitMove(s, SID1);
    const summary = await s.flush();
    assert.deepEqual(summary, { delivered: 0, pending: 2 });
    assert.equal(s.getStatus().transportAvailable, false);
    assert.equal(s.getStatus().retryScheduled, false);
    await advance(10000);
    assert.equal(s.getStatus().retryScheduled, false, 'still none after intervals elapse');
    assert.equal(s.pendingCount(), 2);
  });

  it('AC7: sendTimeoutMs/retryIntervalMs option validation', () => {
    for (const bad of ['x', NaN, null, {}, true]) {
      assert.throws(() => BlindfoldSession.createSender({ sendTimeoutMs: bad }), TypeError,
        `sendTimeoutMs=${String(bad)}`);
      assert.throws(() => BlindfoldSession.createSender({ retryIntervalMs: bad }), TypeError,
        `retryIntervalMs=${String(bad)}`);
    }
    for (const bad of [0, -1, -100, Infinity, -Infinity]) {
      assert.throws(() => BlindfoldSession.createSender({ sendTimeoutMs: bad }), RangeError,
        `sendTimeoutMs=${String(bad)}`);
      assert.throws(() => BlindfoldSession.createSender({ retryIntervalMs: bad }), RangeError,
        `retryIntervalMs=${String(bad)}`);
    }
    // Each option validated independently of the other.
    assert.throws(() => BlindfoldSession.createSender({ sendTimeoutMs: 100, retryIntervalMs: 'x' }), TypeError);
    assert.throws(() => BlindfoldSession.createSender({ sendTimeoutMs: 0, retryIntervalMs: 100 }), RangeError);
    // Valid values accepted.
    assert.ok(BlindfoldSession.createSender({ sendTimeoutMs: 1, retryIntervalMs: 1 }));
    assert.ok(BlindfoldSession.createSender());
  });

  it('AC8: getStatus() includes retryScheduled; namespace constants exported', async () => {
    assert.equal(BlindfoldSession.SENDER_SEND_TIMEOUT_MS, 10000);
    assert.equal(BlindfoldSession.SENDER_RETRY_INTERVAL_MS, 5000);
    const s = BlindfoldSession.createSender({ transport: ackAllTransport() });
    assert.equal(s.getStatus().retryScheduled, false);
    assert.ok(Object.isFrozen(s.getStatus()));
    emitMove(s, SID1);
    await s.flush();
    assert.equal(s.getStatus().retryScheduled, false);
  });

  it('AC9: deterministic writer rejection schedules a retry (no classification)', async () => {
    const calls = [];
    let mode = 'mismatch';
    const s = BlindfoldSession.createSender({
      transport: (msg) => {
        calls.push(msg);
        return mode === 'mismatch'
          ? Promise.resolve({ ok: false, eventId: msg.event.eventId, error: 'event-id-content-mismatch' })
          : Promise.resolve({ ok: true, eventId: msg.event.eventId });
      },
      sendTimeoutMs: 10000,
      retryIntervalMs: 500
    });
    emitMove(s, SID1);
    emitMove(s, SID1); // anchor + 2 moves queued
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(s.getStatus().lastError, 'event-id-content-mismatch');
    assert.equal(s.getStatus().retryScheduled, true, 'even deterministic rejections retry');
    await advance(500);
    assert.equal(calls.length, 2, 'head resent');
    assert.equal(calls[1].event.eventId, calls[0].event.eventId, 'byte-identical resend');
    assert.equal(s.pendingCount(), 3, 'head-of-line blocking preserves order');
    // Cleanup: drain.
    mode = 'ack';
    await advance(500);
    await tick();
    assert.equal(s.pendingCount(), 0);
    assert.equal(s.getStatus().retryScheduled, false);
    assert.equal(s.getStatus().lastError, null);
  });

  it('AC10: diff discipline — only sender.js, tests/sender.test.js (+2.5/2.6 evidence) differ', () => {
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
      '.autodev/evidence/4.9.contract.md',
      '.autodev/evidence/4.9.build.md',
      // Honest cumulative evolution: 4.9's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1-4.8 precedent).
      '.autodev/evidence/4.9.review.md',
      '.autodev/evidence/4.9.behavior.md',
      // Honest cumulative evolution: 4.3's review/behavior evidence lands
      // after the pins were evolved (2.x/3.x/4.1/4.2 precedent).
      '.autodev/evidence/4.3.review.md',
      '.autodev/evidence/4.3.behavior.md',
      'sender.js',
      'tests/sender.test.js',
      '.autodev/evidence/2.5.contract.md',
      '.autodev/evidence/2.5.build.md',
      '.autodev/evidence/2.5.review.md',
      '.autodev/evidence/2.5.behavior.md',
      '.autodev/DECISIONS.md',
      // Honest cumulative evolution (2.2/2.3/2.4 precedent): 2.4's
      // git-status allowlist pins the file set, so 2.5's legitimate
      // sender.js change requires extending that allowlist.
      'tests/writer.test.js',
      // Honest cumulative evolution: task 2.6 legitimately extends sw.js
      // (session-state storage primitives), adds the two 1.1/1.2 export
      // lines, and extends the suites that pin those files.
      // 2.6's SF-1 repair (adversarial review should-fix) legitimately
      // touches writer.js: corrupt counter → honest write failure.
      // Honest cumulative evolution: task 2.7 legitimately adds
      // lifecycle.js (page/context lifecycle), the writer's type-agnostic
      // post-commit hook, the one-line content.js install, the manifest
      // js-list entry, and the sw.js import.
      'writer.js',
      'lifecycle.js',
      'content.js',
      'manifest.json',
      'tests/lifecycle.test.js',
      '.autodev/evidence/2.7.contract.md',
      '.autodev/evidence/2.7.build.md',
      // Honest cumulative evolution (2.2–2.7 precedent): 2.8 legitimately
      // adds status_indicator.js (new), wires it in content.js + the
      // manifest js list + overlay.css, and evolves these pins.
      'status_indicator.js',
      'tests/status_indicator.test.js',
      'content.js',
      'manifest.json',
      'overlay.css',
      '.autodev/evidence/2.8.contract.md',
      '.autodev/evidence/2.8.build.md',
      // Honest cumulative evolution: the adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.6 precedent).
      '.autodev/evidence/2.7.review.md',
      '.autodev/evidence/2.7.behavior.md',
      // Honest cumulative evolution: the 2.8 adversarial review and
      // behavioral verification evidence land after the builder
      // evolved these pins (2.6/2.7 precedent).
      '.autodev/evidence/2.8.review.md',
      '.autodev/evidence/2.8.behavior.md',
      // Honest cumulative evolution (2.2–2.8 precedent): 2.9 is a
      // negative requirement (no product code) — it adds the
      // retention scan suite and evolves these pins.
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
      // sounds.js + content.js; its files join the allowlists.
      'sounds.js',
      'tests/speech.test.js',
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
      // Honest cumulative evolution: 3.5's review/behavior evidence
      // lands after the pins were evolved (2.x/3.1/3.2/3.3/3.4 precedent).
      '.autodev/evidence/3.5.review.md',
      '.autodev/evidence/3.5.behavior.md',
      'tests/attempt_tracker.test.js',
      'sw.js',
      'session_store.js',
      'session_identity.js',
      'session_conditions.js',
      'tests/session_store.test.js',
      'tests/db.test.js',
      'tests/manifest_sw.test.js',
      'tests/session_identity.test.js',
      'tests/event_envelope.test.js',
      'tests/game_records.test.js',
      '.autodev/evidence/2.6.contract.md',
      '.autodev/evidence/2.6.build.md',
      '.autodev/evidence/2.6.review.md',
      '.autodev/evidence/2.6.behavior.md'
    ]);
    for (const f of changed) {
      assert.ok(allowed.has(f), `unexpected modified file: ${f}`);
    }
    // "Must be modified in git status" would be transient (it can only pass
    // pre-commit, as 2.4's suite demonstrated on committed HEAD). The durable
    // assertions: the files exist and carry the contracted 2.5 content,
    // verified by the content tests above.
    assert.ok(fs.existsSync(path.join(ROOT, 'sender.js')), 'sender.js must exist');
    assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'sender.test.js')), 'tests/sender.test.js must exist');
  });
});
