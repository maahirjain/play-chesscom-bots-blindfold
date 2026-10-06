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
const { describe, it } = require('node:test');
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
      transportAvailable: false
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
    assert.deepEqual(manifest.content_scripts[0].js, [
      'event_envelope.js', 'sender.js', 'sounds.js',
      'chess.min.js', 'chess_utils.js', 'content.js'
    ]);
  });

  it('manifest is otherwise byte-identical in meaning to HEAD (only the js list changed)', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const headManifest = JSON.parse(
      execSync('git show HEAD:manifest.json', { cwd: ROOT }).toString()
    );
    headManifest.content_scripts[0].js = manifest.content_scripts[0].js;
    assert.deepEqual(manifest, headManifest);
  });

  it('content.js still carries exactly the one sender-instantiation line (cumulative)', () => {
    // 2.3 added the line via git diff; 2.4 must not add more. Cumulative
    // invariant: the line exists exactly once in the file.
    const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    const needle = 'BlindfoldSession.sender = BlindfoldSession.createSender();';
    const occurrences = content.split(needle).length - 1;
    assert.strictEqual(occurrences, 1, 'expected exactly one sender instantiation line');
  });

  it('db.js is byte-identical to HEAD; sw.js state is owned by the 2.4 contract', () => {
    // 2.4 legitimately amended sw.js (writer intake); its cumulative state
    // is pinned in tests/writer.test.js (AC11). db.js must be untouched.
    const head = execSync('git show HEAD:db.js', { cwd: ROOT });
    const work = fs.readFileSync(path.join(ROOT, 'db.js'));
    assert.ok(head.equals(work), 'db.js differs from HEAD');
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
