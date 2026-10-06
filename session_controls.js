// session_controls.js
//
// Task 5.1 (PLAN.md §5.1): compact Start/Stop control and per-stream
// recording health lights, in-page (not a browser-action popup — PLAN
// §(c) steps 3/4/7 happen on the game page mid-play, and a popup closes
// on focus loss; the 2.8 contract §3.7 already rejected a popup for the
// status surface).
//
// Task 5.2 (PLAN.md §5.2) amends the Start sequence: when the
// session-fields handle is wired (options.sessionFields), the category
// is required at Start, identity is metadata-first (the sessionId sent
// to the recorder IS metadata.sessionId), the session records are
// persisted via the SW-side session-save message BEFORE
// recorder-set-session, and the fields are disabled while the session
// is active (write-once). Without the handle the 5.1 path is
// preserved byte-for-byte in behavior.
//
// Task 5.3 (PLAN.md §5.3) adds one optional install option,
// onSessionStarted: fired exactly once per successful Start at the
// phase → 'active' point with the recorded selection (content.js
// wires it to the selection-memory capture). Guarded in try/catch;
// never fired on abort paths or for boot-adopted sessions.
//
// Two exports, mirroring the 2.8 classifier/renderer split:
//
//   classifyStreamStatus(status, startResult) — pure. Input: one
//     per-stream status object from 4.14's recorder-get-status response
//     (the exact 17-key shape), plus the optional per-stream
//     start-streams result this control observed ({ok, error, ...}).
//     Output: frozen {state, detail} where state is one of the closed
//     7-state set below and detail is the raw fact string(s) (never a
//     smoothed summary). A failed start with lifecycle 'idle' reads
//     'failed-not-started' — without the observed start result a denied
//     device would masquerade as 'off-idle'. Throws TypeError on
//     malformed input. No DOM, no timers, no chrome.* — independently
//     unit-testable.
//
//   installSessionControls(options) — creates the DOM: one compact
//     Start/Stop button + three per-stream lights (mic/screen/webcam),
//     anchored adjacent to the extension's own move-input UI (fixed-corner
//     fallback, 2.8 precedent). Wires the Start/Stop sequences (contract
//     §3.3/§3.4), polls recorder-get-status ONLY while a session is active
//     (injectable interval, 2 s default — the 2.8 precedent; no pre-session
//     polling, so no pointless SW wakes), re-renders only on state/detail
//     change. Never throws into page code (3.2 SF-1 precedent:
//     instrumentation/UI never breaks gameplay); invalid options throw
//     TypeError at install time, before any timer starts.
//
// The existing 2.8 saving indicator is unchanged (it keeps showing
// sender/storage health). 5.1's cluster sits beside it: four lights
// total, exactly PLAN §(c) step 4's "microphone, screen, webcam, and
// saving indicators".
//
// The 4.14 no-smoothing discipline applies end to end: failures surface
// as facts (light state + raw detail tooltip), never as a collapsed
// lifecycle. The critical masquerade case — chunk-stalled with
// recorderState 'recording' — stays recording-degraded (amber), never
// green. "Ready" is NOT defined here: 5.6 owns the required-set policy.
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// plain Error = unavailable platform capability.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Closed light-state set (contract §4). Mechanical derivation from
  // 4.14's lifecycle + adverse facts — no smoothed 'error' state.
  // ------------------------------------------------------------------

  var LIGHT_OFF_IDLE = 'off-idle';
  var LIGHT_FAILED_NOT_STARTED = 'failed-not-started';
  var LIGHT_RECORDING_HEALTHY = 'recording-healthy';
  var LIGHT_RECORDING_DEGRADED = 'recording-degraded';
  var LIGHT_STOPPED_FINALIZING = 'stopped-finalizing';
  var LIGHT_FINALIZED = 'finalized';
  var LIGHT_UNKNOWN = 'unknown';

  var LIGHT_STATES = Object.freeze([
    LIGHT_OFF_IDLE,
    LIGHT_FAILED_NOT_STARTED,
    LIGHT_RECORDING_HEALTHY,
    LIGHT_RECORDING_DEGRADED,
    LIGHT_STOPPED_FINALIZING,
    LIGHT_FINALIZED,
    LIGHT_UNKNOWN
  ]);

  var LIFECYCLE_IDLE = 'idle';
  var LIFECYCLE_RECORDING = 'recording';
  var LIFECYCLE_STOPPED = 'stopped';
  var LIFECYCLE_FINALIZED = 'finalized';

  // 4.8's terminal chunk states (contract §4 adverse-facts closed list).
  var TERMINAL_CHUNK_STATUSES = Object.freeze([
    'chunk-stalled',
    'chunk-quota-exceeded',
    'chunk-write-error'
  ]);

  var STREAM_KINDS = Object.freeze(['microphone', 'screen', 'webcam']);

  var DEFAULT_POLL_INTERVAL_MS = 2000;

  // Recorder channel envelope (the {kind:'recorder', v:1} envelope the
  // offscreen document and the SW recording_host both speak). 5.1 sends
  // no new offscreen-document messages — every msg below already exists
  // except recorder-ensure, which is SW-side (recording_host).
  var RECORDER_MSG_KIND = 'recorder';
  var RECORDER_PROTOCOL_V = 1;
  var MSG_ENSURE = 'recorder-ensure';
  var MSG_SET_SESSION = 'recorder-set-session';
  var MSG_START_STREAMS = 'recorder-start-streams';
  var MSG_STOP_STREAMS = 'recorder-stop-streams';
  var MSG_GET_STATUS = 'recorder-get-status';
  // 5.2: SW-side session intake (recording_host). The content script
  // cannot reach extension IDB (2.2); this persists the session
  // metadata + initial conditions BEFORE the recorder ever sees the
  // session. Not an offscreen-document message — offscreen MSG_*
  // stays at 24.
  var MSG_SESSION_SAVE = 'session-save';

  var CONTROL_PHASE_IDLE = 'idle';
  var CONTROL_PHASE_STARTING = 'starting';
  var CONTROL_PHASE_ACTIVE = 'active';
  var CONTROL_PHASE_STOPPING = 'stopping';

  // ------------------------------------------------------------------
  // Pure classification.
  // ------------------------------------------------------------------

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function stringOrNull(v) {
    return (typeof v === 'string') ? v : null;
  }

  // Collect the adverse facts (contract §4 closed list) as raw fact
  // strings. Lenient on field shape: a malformed field is absent
  // evidence, not a classifier crash — the light degrades to facts
  // present/absent, never to a throw in the poll loop. (Malformed
  // *input* — non-object status, non-string lifecycle — is a caller
  // error and throws TypeError.)
  function collectAdverseFacts(status) {
    var facts = [];
    var chunk = isPlainObject(status.chunk) ? status.chunk : null;
    if (chunk !== null) {
      var cs = stringOrNull(chunk.status);
      if (cs !== null && TERMINAL_CHUNK_STATUSES.indexOf(cs) !== -1) {
        facts.push('chunk:' + cs);
      }
    }
    var err = isPlainObject(status.lastRecorderError) ?
      status.lastRecorderError : null;
    if (err !== null) {
      facts.push('recorder-error:' +
        (stringOrNull(err.errorName) || 'unknown'));
    }
    var disc = isPlainObject(status.lastDiscontinuity) ?
      status.lastDiscontinuity : null;
    if (disc !== null) {
      facts.push('discontinuity:' +
        (stringOrNull(disc.reason) || 'unknown'));
    }
    var tracks = Array.isArray(status.tracks) ? status.tracks : [];
    for (var i = 0; i < tracks.length; i++) {
      var t = isPlainObject(tracks[i]) ? tracks[i] : {};
      var kind = stringOrNull(t.trackKind) || 'track';
      if (t.readyState === 'ended') {
        facts.push('track:ended(' + kind + ')');
      } else if (t.muted === true) {
        facts.push('track:muted(' + kind + ')');
      }
    }
    return facts;
  }

  // classifyStreamStatus(status, startResult) → frozen {state, detail}.
  // detail is the '; '-joined raw fact strings, or null when clean.
  //
  // startResult (optional): the per-stream start-streams result this
  // control observed ({ok, error, ...}) for the same kind. A failed
  // start with lifecycle 'idle' is the 'failed-not-started' state —
  // the 4.14 status shape carries no start-failure detail (a
  // never-started stream has no recorder error, discontinuity, or
  // tracks), so without this the light would read 'off-idle' and a
  // denied device would be indistinguishable from "not started yet".
  // On boot adoption there is no observed start → startResult is
  // null/undefined and the light is honestly 'off-idle'.
  function classifyStreamStatus(status, startResult) {
    if (!isPlainObject(status)) {
      throw new TypeError('status must be a per-stream status object');
    }
    var lifecycle = status.lifecycle;
    if (typeof lifecycle !== 'string') {
      throw new TypeError('status.lifecycle must be a string');
    }
    var finalizedAtUtc = stringOrNull(status.finalizedAtUtc);
    var facts = collectAdverseFacts(status);
    var failedStart = isPlainObject(startResult) && startResult.ok === false;
    if (failedStart) {
      var serr = stringOrNull(startResult.error) || 'unknown';
      facts.unshift('start-failed:' + serr);
    }
    var detail = facts.length > 0 ? facts.join('; ') : null;
    var state;
    if (lifecycle === LIFECYCLE_FINALIZED) {
      state = LIGHT_FINALIZED;
    } else if (finalizedAtUtc !== null) {
      // Contract §4 table: finalizedAtUtc !== null → finalized. The one
      // inconsistent input (recording + finalizedAtUtc set) cannot occur
      // under 4.14's createdAtUtc-primary manifest ordering; if it ever
      // does, fail safe toward showing the problem — degraded, never
      // green, with the inconsistency itself as a fact.
      if (lifecycle === LIFECYCLE_RECORDING) {
        state = LIGHT_RECORDING_DEGRADED;
        detail = (detail ? detail + '; ' : '') +
          'inconsistent:finalizedAtUtc-set-while-recording';
      } else {
        state = LIGHT_FINALIZED;
      }
    } else if (lifecycle === LIFECYCLE_STOPPED) {
      state = LIGHT_STOPPED_FINALIZING;
    } else if (lifecycle === LIFECYCLE_IDLE) {
      state = facts.length > 0 ? LIGHT_FAILED_NOT_STARTED : LIGHT_OFF_IDLE;
    } else if (lifecycle === LIFECYCLE_RECORDING) {
      // The critical masquerade case lives here: chunk-stalled with
      // recorderState 'recording' keeps lifecycle 'recording', and the
      // stall surfaces as a fact — degraded (amber), never healthy.
      state = facts.length > 0 ?
        LIGHT_RECORDING_DEGRADED : LIGHT_RECORDING_HEALTHY;
    } else {
      // Unknown lifecycle string: never green.
      state = LIGHT_UNKNOWN;
    }
    return Object.freeze({ state: state, detail: detail });
  }

  // ------------------------------------------------------------------
  // 5.6: readiness policy (PLAN.md §5.6).
  //
  // computeReadiness(streamStatuses, senderStatus, startResults,
  //   initialEmitObserved) — pure. Inputs:
  //   - streamStatuses: the 4.14 per-stream status objects ({microphone,
  //     screen, webcam} -> 17-key status), or null/malformed when the
  //     status query itself failed.
  //   - senderStatus: the object returned by sender.getStatus()
  //     ({pendingCount, lastError, transportAvailable, retryScheduled}),
  //     or null when unavailable (sender without getStatus, throwing
  //     getStatus — never a reason to claim ready).
  //   - startResults: the per-stream start-streams results 5.1 remembers
  //     (lastStartResults), or null.
  //   - initialEmitObserved: boolean — true when this control observed
  //     the Start's initial event emission (emitPageStart succeeded).
  //     False on boot adoption or when the emission was never observed;
  //     the storage signal is then ambiguous and can never yield ready.
  //
  // Output: frozen {verdict, reasons, blocked} where verdict is one of
  //   'ready' | 'not-ready' | 'unknown', reasons is a frozen array of
  //   raw fact strings, and blocked is true when a confirmed failure
  //   (vs mere pending) keeps the session from being ready.
  //
  // The required set is all three stream kinds (contract §2.1). A stream
  // counts as started only when it classifies 'recording-healthy' —
  // 'recording-degraded' is recording but not healthy and never counts
  // (the 4.14 masquerade rule). Storage counts only when ≥1 event
  // emitted since Start has been durably acknowledged: the sender
  // dequeues exclusively on positive ack, so pendingCount===0 with
  // lastError===null and an observed initial emission honestly means
  // every emitted event was acknowledged. Ambiguous signals degrade to
  // not-ready, never to a premature ready.
  //
  // No DOM, no timers, no chrome.* — independently unit-testable.
  // Throws TypeError only on wrong-typed streamStatuses/startResults
  // containers (caller error); a null streamStatuses is the honest
  // 'unknown' (query failed), not a throw.
  // ------------------------------------------------------------------

  var READINESS_READY = 'ready';
  var READINESS_NOT_READY = 'not-ready';
  var READINESS_UNKNOWN = 'unknown';

  var READINESS_VERDICTS = Object.freeze([
    READINESS_READY,
    READINESS_NOT_READY,
    READINESS_UNKNOWN
  ]);

  // 2.8's sender-error taxonomy (status_indicator.js): the transient
  // family recovers via the 2.5 retry; anything else non-null is a
  // persistent write failure (fail-closed).
  function isTransientSenderError(err) {
    return err === 'send-timeout' || err === 'no-ack' ||
      (typeof err === 'string' && err.indexOf('transport-error:') === 0);
  }

  // Storage readiness for 5.6's purpose. Returns {ready, reason, blocked}.
  // reason is null when ready; blocked distinguishes a confirmed failure
  // from mere pending.
  function classifyStorageReadiness(senderStatus, initialEmitObserved) {
    if (!isPlainObject(senderStatus) ||
        typeof senderStatus.pendingCount !== 'number' ||
        !isFinite(senderStatus.pendingCount) ||
        (senderStatus.lastError !== null &&
         typeof senderStatus.lastError !== 'string')) {
      return {
        ready: false,
        reason: 'storage status unavailable',
        blocked: true
      };
    }
    var lastError = senderStatus.lastError;
    if (lastError !== null && !isTransientSenderError(lastError)) {
      // Persistent write failure (write-failed:* or unrecognized) —
      // the head event never dequeues, so this latches. Fail-closed.
      return {
        ready: false,
        reason: 'storage write failed: ' + lastError,
        blocked: true
      };
    }
    if (initialEmitObserved !== true) {
      // No emission observed in this context (boot adoption, or the
      // Start path was never taken here). pendingCount===0 /
      // lastError===null is then ambiguous — it cannot confirm the
      // initial write. Never a premature ready.
      return {
        ready: false,
        reason: 'storage write unconfirmed',
        blocked: true
      };
    }
    if (senderStatus.pendingCount > 0) {
      return {
        ready: false,
        reason: 'storage write pending',
        blocked: false
      };
    }
    if (lastError !== null) {
      // Transient failure with an empty queue: the pump will retry
      // (2.5); the write has not succeeded yet.
      return {
        ready: false,
        reason: 'storage write retrying: ' + lastError,
        blocked: false
      };
    }
    // pendingCount===0, lastError===null, initial emission observed:
    // the sender dequeues exclusively on positive ack, so every event
    // emitted since Start has been durably acknowledged.
    return { ready: true, reason: null, blocked: false };
  }

  function computeReadiness(streamStatuses, senderStatus, startResults,
      initialEmitObserved) {
    if (streamStatuses !== null && streamStatuses !== undefined &&
        !isPlainObject(streamStatuses)) {
      throw new TypeError(
        'streamStatuses must be an object, null, or undefined');
    }
    if (startResults !== null && startResults !== undefined &&
        !isPlainObject(startResults)) {
      throw new TypeError(
        'startResults must be an object, null, or undefined');
    }
    // The status query itself failed or returned malformed data:
    // unknown is unknown; never default to ready.
    if (!isPlainObject(streamStatuses)) {
      return Object.freeze({
        verdict: READINESS_UNKNOWN,
        reasons: Object.freeze(['status query failed']),
        blocked: false
      });
    }
    var reasons = [];
    var blocked = false;
    var allStreamsReady = true;
    for (var i = 0; i < STREAM_KINDS.length; i++) {
      var kind = STREAM_KINDS[i];
      var st = isPlainObject(streamStatuses[kind]) ?
        streamStatuses[kind] : null;
      if (st === null) {
        allStreamsReady = false;
        blocked = true;
        reasons.push(kind + ': no status in response');
        continue;
      }
      var classified;
      try {
        classified = classifyStreamStatus(st,
          (isPlainObject(startResults) ? startResults[kind] : null) || null);
      } catch (e) {
        allStreamsReady = false;
        blocked = true;
        reasons.push(kind + ': malformed status');
        continue;
      }
      if (classified.state !== LIGHT_RECORDING_HEALTHY) {
        allStreamsReady = false;
        var r = kind + ': ' + classified.state;
        if (classified.detail) {
          r += ' (' + classified.detail + ')';
        }
        reasons.push(r);
        // A confirmed failure blocks; mere not-yet-started waits.
        // 'failed-not-started' and 'recording-degraded' are failures;
        // a malformed/unknown stream is a blocker (cannot confirm);
        // 'off-idle' with no failure facts is still pending.
        if (classified.state === LIGHT_FAILED_NOT_STARTED ||
            classified.state === LIGHT_RECORDING_DEGRADED ||
            classified.state === LIGHT_UNKNOWN) {
          blocked = true;
        }
      }
    }
    var storage = classifyStorageReadiness(senderStatus,
      initialEmitObserved);
    if (!storage.ready) {
      allStreamsReady = false;
      reasons.push(storage.reason);
      if (storage.blocked) {
        blocked = true;
      }
    }
    if (allStreamsReady) {
      return Object.freeze({
        verdict: READINESS_READY,
        reasons: Object.freeze([]),
        blocked: false
      });
    }
    return Object.freeze({
      verdict: READINESS_NOT_READY,
      reasons: Object.freeze(reasons),
      blocked: blocked
    });
  }

  // ------------------------------------------------------------------
  // Installation: DOM + Start/Stop wiring.
  // ------------------------------------------------------------------

  function defaultNoop() {}

  // 5.2: the session-fields handle shape (installSessionFields's
  // return). showAdoptedCategory is 5.2's adoption presentation;
  // guarded at use (not required here) so 5.3-era handles stay
  // compatible.
  function isFieldsHandle(h) {
    return isPlainObject(h) &&
      typeof h.getSelection === 'function' &&
      typeof h.setSelection === 'function' &&
      typeof h.setEnabled === 'function' &&
      typeof h.getDetectedConditions === 'function';
  }

  function validateOptions(options) {
    if (!isPlainObject(options)) {
      throw new TypeError('options must be an object');
    }
    var sender = options.sender;
    if (!isPlainObject(sender) || typeof sender.emit !== 'function') {
      throw new TypeError('options.sender must expose emit()');
    }
    var sendRecorderMessage = options.sendRecorderMessage;
    if (typeof sendRecorderMessage !== 'function') {
      throw new TypeError('options.sendRecorderMessage must be a function');
    }
    var glr = options.gameLifecycleRecorder;
    if (!isPlainObject(glr) ||
        typeof glr.recordStopTermination !== 'function' ||
        typeof glr.resetEnded !== 'function') {
      throw new TypeError(
        'options.gameLifecycleRecorder must expose ' +
        'recordStopTermination() and resetEnded()');
    }
    // getLastObservedEnd is the 5.1 additive getter on the 3.5 recorder
    // (contract §3.4: null reason unless a game_ended was observed).
    // Required — without it the Stop sequence cannot honor the seam.
    if (typeof glr.getLastObservedEnd !== 'function') {
      throw new TypeError(
        'options.gameLifecycleRecorder must expose getLastObservedEnd()');
    }
    var intervalMs = options.intervalMs === undefined ?
      DEFAULT_POLL_INTERVAL_MS : options.intervalMs;
    if (typeof intervalMs !== 'number' || !isFinite(intervalMs) ||
        intervalMs <= 0) {
      throw new TypeError('options.intervalMs must be a positive finite number');
    }
    var onStopComplete = options.onStopComplete === undefined ?
      defaultNoop : options.onStopComplete;
    if (typeof onStopComplete !== 'function') {
      throw new TypeError('options.onStopComplete must be a function');
    }
    // 5.3: remembered-defaults capture hook. Optional (5.1/5.2-era
    // callers stay compatible): fired exactly once per successful
    // Start, at the phase → 'active' point, with the selection object
    // that was recorded (getSelection() at Start, the same values
    // session-save persisted). Not fired on any abort path, and not
    // fired for boot-adopted sessions (adoption is not a Start).
    // Guarded in try/catch at the call site — a throwing callback
    // must never break Start (3.2 SF-1).
    var onSessionStarted = options.onSessionStarted === undefined ?
      defaultNoop : options.onSessionStarted;
    if (typeof onSessionStarted !== 'function') {
      throw new TypeError('options.onSessionStarted must be a function');
    }
    // 5.2: the session-fields handle (or a thunk returning it — the
    // content script installs the fields after the controls, so the
    // handle does not exist at controls-install time). Null/undefined
    // → the 5.1 path (no category gating, newSessionId minting, no
    // session-save); this is the seam 5.1-era callers and tests use.
    // In production content.js always wires the real handle.
    var sessionFieldsOpt = options.sessionFields;
    var getSessionFields;
    if (sessionFieldsOpt === undefined || sessionFieldsOpt === null) {
      getSessionFields = function () { return null; };
    } else if (typeof sessionFieldsOpt === 'function') {
      getSessionFields = sessionFieldsOpt;
    } else if (isFieldsHandle(sessionFieldsOpt)) {
      getSessionFields = function () { return sessionFieldsOpt; };
    } else {
      throw new TypeError(
        'options.sessionFields must be a fields handle, a thunk, or null');
    }
    // 5.2: the extension version for metadata-first minting (the 1.1
    // header: call sites inject it). Required exactly when the fields
    // path is active.
    var extensionVersion = options.extensionVersion;
    if (sessionFieldsOpt !== undefined && sessionFieldsOpt !== null) {
      if (typeof extensionVersion !== 'string' ||
          extensionVersion.trim() === '') {
        throw new TypeError(
          'options.extensionVersion must be a non-empty string when ' +
          'sessionFields is provided');
      }
      extensionVersion = extensionVersion.trim();
    }
    return {
      sender: sender,
      sendRecorderMessage: sendRecorderMessage,
      gameLifecycleRecorder: glr,
      intervalMs: intervalMs,
      onStopComplete: onStopComplete,
      getSessionFields: getSessionFields,
      extensionVersion: extensionVersion,
      onSessionStarted: onSessionStarted
    };
  }

  function recorderEnvelope(msg, extra) {
    var env = { kind: RECORDER_MSG_KIND, v: RECORDER_PROTOCOL_V, msg: msg };
    if (isPlainObject(extra)) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) {
          env[k] = extra[k];
        }
      }
    }
    return env;
  }

  function installSessionControls(options) {
    var opts = validateOptions(options);

    var doc = (typeof document !== 'undefined') ? document : null;
    if (doc === null) {
      throw new Error('session controls require a document');
    }
    var BS = (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession) ?
      globalThis.BlindfoldSession : BlindfoldSession;
    if (typeof BS.newSessionId !== 'function' ||
        typeof BS.newGameId !== 'function') {
      // session_identity.js must be in the content_scripts list (5.1).
      throw new Error('session identity minting is unavailable');
    }

    // ---- DOM -------------------------------------------------------
    var cluster = doc.createElement('span');
    cluster.className = 'blindfold-session-controls';

    var button = doc.createElement('button');
    button.type = 'button';
    button.className = 'blindfold-session-startstop';
    button.textContent = 'Start';
    button.setAttribute('aria-label', 'Start recording session');
    cluster.appendChild(button);

    var lights = {};
    for (var li = 0; li < STREAM_KINDS.length; li++) {
      (function (kind) {
        var light = doc.createElement('span');
        light.className = 'blindfold-stream-light blindfold-stream-' +
          LIGHT_OFF_IDLE;
        light.setAttribute('data-stream-kind', kind);
        light.setAttribute('aria-hidden', 'true');
        light.textContent = '●';
        light.title = kind + ': not started';
        cluster.appendChild(light);
        lights[kind] = light;
      })(STREAM_KINDS[li]);
    }

    // 5.6: readiness badge (PLAN.md §5.6). A text summary of the
    // readiness verdict — "Waiting for recording…" until all required
    // streams are recording-healthy and the initial storage write is
    // confirmed, then "Ready — recording" (latched per session).
    // Presentation-only: it never gates the session or the Stop
    // button. Hidden while idle (no session).
    var readinessEl = doc.createElement('span');
    readinessEl.className = 'blindfold-readiness';
    readinessEl.setAttribute('data-readiness', 'hidden');
    readinessEl.setAttribute('aria-hidden', 'true');
    readinessEl.textContent = '';
    try {
      readinessEl.style.display = 'none';
    } catch (e) { /* non-CSS DOM stub */ }
    cluster.appendChild(readinessEl);

    // Anchor: the extension's own move-input UI (2.8 precedent), so the
    // cluster reads [Start][mic][screen][webcam] ahead of 2.8's saving
    // light — four lights total, PLAN §(c) step 4. Fixed-corner fallback
    // when the anchor is absent.
    var usedFallback = false;
    var anchor = doc.getElementById('blindfold-chess-move-input');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(cluster, anchor.nextSibling);
    } else {
      usedFallback = true;
      cluster.className += ' blindfold-session-controls-fallback';
      doc.body.appendChild(cluster);
    }

    // ---- Control state ----------------------------------------------
    var phase = CONTROL_PHASE_IDLE;
    var activeSessionId = null;
    var activeGameId = null;
    var timerId = null;
    var stopped = false;
    var lastRendered = {}; // kind -> {state, detail} | null
    var lastStopResponse = null;
    // The per-stream start-streams results this control observed
    // (kind -> {ok, error, ...}). Feeds classifyStreamStatus so a
    // failed start reads 'failed-not-started' instead of 'off-idle'.
    // Cleared on Stop and on each new Start; empty on boot adoption
    // (the reloaded control observed no start).
    var lastStartResults = {};
    // 5.6: readiness state. readinessLatched is set on the first
    // 'ready' verdict and holds for the session (no flapping — the
    // "initial" conditions were met; ongoing health stays the lights'
    // job). pageStartEmitted tracks whether this control observed the
    // Start's initial event emission (emitPageStart); false on boot
    // adoption — the storage signal is then ambiguous and can never
    // yield ready. lastReadinessRendered is {verdict, text} for
    // change-detected DOM updates.
    var readinessLatched = false;
    var pageStartEmitted = false;
    var lastReadinessRendered = null;

    function setButton(label, enabled, detailText, ariaLabel) {
      button.textContent = label;
      button.disabled = !enabled;
      button.setAttribute('aria-label', ariaLabel);
      if (detailText === null || detailText === undefined) {
        button.removeAttribute('title');
      } else {
        button.setAttribute('title', detailText);
      }
    }

    function renderLight(kind, classified) {
      var prev = lastRendered[kind] || null;
      if (prev !== null && prev.state === classified.state &&
          prev.detail === classified.detail) {
        return; // no DOM churn per poll
      }
      lastRendered[kind] = classified;
      var light = lights[kind];
      var base = 'blindfold-stream-light blindfold-stream-' + classified.state;
      if (usedFallback) {
        base += ' blindfold-stream-light-fallback';
      }
      light.className = base;
      light.title = kind + ': ' + classified.state +
        (classified.detail ? ' — ' + classified.detail : '');
    }

    function renderUnknown(kind, detailText) {
      renderLight(kind, { state: LIGHT_UNKNOWN, detail: detailText });
    }

    function renderAllUnknown(detailText) {
      for (var i = 0; i < STREAM_KINDS.length; i++) {
        renderUnknown(STREAM_KINDS[i], detailText);
      }
    }

    // 5.6: readiness badge rendering. Change-detected (no DOM churn
    // per poll). Takes the computeReadiness result ({verdict, reasons,
    // blocked}) or the 'hidden' sentinel. Never throws into the poll
    // loop (3.2 SF-1).
    function renderReadiness(readiness) {
      var verdict = readiness === 'hidden' ? 'hidden' : readiness.verdict;
      var reasons = readiness === 'hidden' || !Array.isArray(readiness.reasons) ?
        [] : readiness.reasons;
      var blocked = readiness !== 'hidden' && readiness.blocked === true;
      var text;
      var dataState;
      if (verdict === 'hidden') {
        text = '';
        dataState = 'hidden';
      } else if (verdict === READINESS_READY) {
        text = 'Ready \u2014 recording';
        dataState = 'ready';
      } else if (verdict === READINESS_UNKNOWN) {
        text = 'Recording status unknown';
        dataState = 'unknown';
      } else if (blocked) {
        // Confirmed failure: name the blocker honestly.
        text = 'Not ready: ' + reasons.join('; ');
        dataState = 'not-ready';
      } else {
        // Still pending (streams not yet started, storage write in
        // flight): waiting, never a premature "ready".
        text = 'Waiting for recording\u2026';
        dataState = 'waiting';
      }
      var prev = lastReadinessRendered;
      if (prev !== null && prev.verdict === dataState && prev.text === text) {
        return; // no DOM churn per poll
      }
      lastReadinessRendered = { verdict: dataState, text: text };
      try {
        readinessEl.textContent = text;
        readinessEl.setAttribute('data-readiness', dataState);
        if (verdict === 'hidden') {
          readinessEl.setAttribute('aria-hidden', 'true');
          try {
            readinessEl.style.display = 'none';
          } catch (e) { /* non-CSS DOM stub */ }
        } else {
          readinessEl.setAttribute('aria-hidden', 'false');
          try {
            readinessEl.style.display = '';
          } catch (e) { /* non-CSS DOM stub */ }
          var title = (verdict === READINESS_READY) ?
            'All required streams recording; initial storage write confirmed' :
            text;
          readinessEl.setAttribute('title', title);
        }
      } catch (e) { /* never break the poll on a render throw */ }
    }

    function applyStatusResponse(statuses) {
      // statuses: {microphone: {...}, screen: {...}, webcam: {...}} or
      // missing kinds (a kind absent from the response is unknown, not
      // idle — absence of evidence is not evidence of idleness).
      for (var i = 0; i < STREAM_KINDS.length; i++) {
        var kind = STREAM_KINDS[i];
        var st = (statuses && isPlainObject(statuses[kind])) ?
          statuses[kind] : null;
        if (st === null) {
          renderUnknown(kind, 'no status in response');
          continue;
        }
        var classified;
        try {
          classified = classifyStreamStatus(st,
            lastStartResults[kind] || null);
        } catch (e) {
          renderUnknown(kind, 'malformed status');
          continue;
        }
        renderLight(kind, classified);
      }
    }

    function pollOnce() {
      if (stopped) {
        return Promise.resolve();
      }
      var p;
      try {
        p = opts.sendRecorderMessage(recorderEnvelope(MSG_GET_STATUS));
      } catch (e) {
        renderAllUnknown('query-failed');
        // 5.6: status unknown (unless latched ready).
        if (!readinessLatched) {
          renderReadiness({
            verdict: READINESS_UNKNOWN,
            reasons: ['query-failed'],
            blocked: false
          });
        }
        return Promise.resolve();
      }
      return Promise.resolve(p).then(function (resp) {
        if (stopped) {
          return;
        }
        if (!isPlainObject(resp) || resp.ok !== true) {
          var err = (isPlainObject(resp) && typeof resp.error === 'string') ?
            resp.error : 'no-response';
          renderAllUnknown(err);
          // 5.6: status unknown (unless latched ready).
          if (!readinessLatched) {
            renderReadiness({
              verdict: READINESS_UNKNOWN,
              reasons: [err],
              blocked: false
            });
          }
          return;
        }
        applyStatusResponse(resp.statuses);
        // 5.6: feed the readiness policy from the same poll. No new
        // poll cadence, no new channel messages. The sender status is
        // read defensively — a sender without getStatus() (5.1-era) or
        // a throwing getStatus degrades to storage-unconfirmed, never
        // to a premature ready.
        var senderStatus = null;
        try {
          if (opts.sender !== null && typeof opts.sender === 'object' &&
              typeof opts.sender.getStatus === 'function') {
            senderStatus = opts.sender.getStatus();
          }
        } catch (e) { /* senderStatus stays null */ }
        var readiness;
        try {
          readiness = computeReadiness(resp.statuses, senderStatus,
            lastStartResults, pageStartEmitted);
        } catch (e) {
          readiness = {
            verdict: READINESS_UNKNOWN,
            reasons: ['readiness computation failed'],
            blocked: false
          };
        }
        if (readiness.verdict === READINESS_READY) {
          readinessLatched = true;
        }
        renderReadiness(readinessLatched ?
          { verdict: READINESS_READY, reasons: [], blocked: false } :
          readiness);
      }, function () {
        if (!stopped) {
          renderAllUnknown('query-failed');
          // 5.6: status unknown (unless latched ready).
          if (!readinessLatched) {
            renderReadiness({
              verdict: READINESS_UNKNOWN,
              reasons: ['query-failed'],
              blocked: false
            });
          }
        }
      });
    }

    function schedulePoll() {
      if (stopped || timerId !== null) {
        return;
      }
      var setTimeoutFn = globalThis.setTimeout;
      timerId = setTimeoutFn(function () {
        timerId = null;
        if (stopped) {
          return;
        }
        // Poll only while a session is live (active or stopping):
        // no pre-session polling, so no pointless SW wakes (contract
        // §3.1). A throwing poll never propagates (3.2 SF-1).
        if (phase === CONTROL_PHASE_ACTIVE ||
            phase === CONTROL_PHASE_STOPPING) {
          try {
            pollOnce();
          } catch (e) { /* unreachable by construction; fail-safe */ }
          schedulePoll();
        }
      }, opts.intervalMs);
    }

    function stopPolling() {
      if (timerId !== null) {
        try {
          globalThis.clearTimeout(timerId);
        } catch (e) { /* ignore */ }
        timerId = null;
      }
    }

    function setSlots(sessionId, gameId) {
      activeSessionId = sessionId;
      activeGameId = gameId;
      // The 2.7 seam: §5 sets these at Start; content.js instrumentation
      // reads them. Cleared at Stop.
      BS.activeSessionId = sessionId;
      BS.activeGameId = gameId;
    }

    function channelCall(msg, extra) {
      return Promise.resolve()
        .then(function () {
          return opts.sendRecorderMessage(recorderEnvelope(msg, extra));
        });
    }

    // Best-effort: after a failed Start (post set-session), release the
    // recorder-side session so it does not linger as an orphan the
    // next Start must work around. Failures are swallowed — the
    // finalizer's crash recovery owns true orphans (4.13).
    function clearRecorderSession() {
      try {
        var p = channelCall(MSG_SET_SESSION,
          { sessionId: null, gameId: null });
        if (p && typeof p.catch === 'function') {
          p.catch(function () { /* best-effort */ });
        }
      } catch (e) { /* best-effort */ }
    }

    // 5.6: reset readiness state (badge hidden while idle). Called on
    // every path that returns to idle.
    function resetReadiness() {
      readinessLatched = false;
      pageStartEmitted = false;
      renderReadiness('hidden');
    }

    function abortStart(detailText) {
      clearRecorderSession();
      setSlots(null, null);
      lastStartResults = {};
      resetReadiness();
      phase = CONTROL_PHASE_IDLE;
      setButton('Start', true, detailText, 'Start recording session');
    }

    // 5.5: local-only abort — resets this tab's control WITHOUT
    // touching recorder-side state. Used when the failure means
    // another tab may hold the active session (pre-check refusal,
    // set-session 'session-active' refusal, post-pre-check mint
    // failure): clearRecorderSession would send
    // set-session{null,null}, which the 5.5 guard allows as the
    // Stop-clear — wiping the other tab's session.
    function localAbortStart(detailText) {
      setSlots(null, null);
      lastStartResults = {};
      resetReadiness();
      phase = CONTROL_PHASE_IDLE;
      setButton('Start', true, detailText, 'Start recording session');
    }

    // 5.2: resolve the fields handle for this Start. null → the 5.1
    // path. A malformed handle is a programming error — fail the
    // Start honestly rather than silently dropping the category.
    function resolveFieldsHandle() {
      var h;
      try {
        h = opts.getSessionFields();
      } catch (e) {
        return null;
      }
      if (h === null || h === undefined) {
        return null;
      }
      return isFieldsHandle(h) ? h : false;
    }

    // ---- Start -------------------------------------------------------
    function onStartClick() {
      if (phase !== CONTROL_PHASE_IDLE) {
        // Local interlock (5.1): the button is disabled while not idle,
        // so this is the double-dispatch guard, not the UX path. The
        // one deliberate exception is CONTROL_PHASE_STOPPING (see
        // onStopClick): a failed stop may be retried.
        return;
      }
      phase = CONTROL_PHASE_STARTING;
      setButton('Starting…', false, null, 'Starting recording session');
      // 5.6: reset readiness latch; show "waiting" immediately — the
      // poll refines it once the session is active. (Aborts hide the
      // badge via resetReadiness.)
      readinessLatched = false;
      pageStartEmitted = false;
      renderReadiness({
        verdict: READINESS_NOT_READY,
        reasons: [],
        blocked: false
      });

      var fieldsHandle = resolveFieldsHandle();
      if (fieldsHandle === false) {
        // 5.5 (review N2): local-only abort — this tab has minted
        // nothing and owns no recorder session here, so
        // clearRecorderSession() would only risk wiping another tab's
        // active session via the Stop-clear path.
        localAbortStart('fields-malformed');
        return;
      }

      var sessionId;
      var gameId;
      // 5.2: metadata-first minting. When the fields handle is present
      // the category is REQUIRED at Start (PLAN §(c) step 2 → step 3);
      // identity is single-sourced in 1.1 — the sessionId sent to the
      // recorder IS metadata.sessionId. protocolVersion is null
      // (unknown): the user maintains protocol.md outside the
      // extension (1.1 normalizeProtocolVersion).
      //
      // 5.5: the minting itself happens AFTER recorder-ensure, in the
      // chain below — so the duplicate-Start pre-check aborts before
      // anything is minted. Only the selection read and the category
      // validation stay here; they mint nothing.
      var metadata = null;
      var conditions = null;
      var sessionCategory = null;
      var factoriesOk = false;
      var selection = null;
      if (fieldsHandle !== null) {
        factoriesOk =
          typeof BS.isSessionCategory === 'function' &&
          typeof BS.createSessionMetadata === 'function' &&
          typeof BS.addGameToSession === 'function' &&
          typeof BS.buildInitialConditions === 'function';
        if (factoriesOk) {
          try {
            selection = fieldsHandle.getSelection();
          } catch (e) {
            selection = null;
          }
        }
        sessionCategory = (selection !== null &&
          typeof selection.sessionCategory === 'string') ?
          selection.sessionCategory : null;
        if (!factoriesOk || !BS.isSessionCategory(sessionCategory)) {
          // Honest abort: nothing minted, nothing persisted, no
          // recorder message sent (the 5.1 ensure-failure honesty
          // pattern). createSessionMetadata admits no unknown
          // category (1.1 RangeError); 1.2.3's "represent unavailable
          // as unknown" applies to conditions, not to the 1.1 metadata
          // category — so Start cannot proceed uncategorized.
          resetReadiness();
          phase = CONTROL_PHASE_IDLE;
          setButton('Start', true,
            factoriesOk ? 'no-category-selected' : 'record-build-failed',
            'Start recording session');
          return;
        }
      }

      // Contract §3.2 order (5.5): interlock → validate selection →
      // recorder-ensure → pre-check → mint → build records →
      // session-save → recorder-set-session → recorder-start-streams
      // → slots + emitPageStart + poll. session-save sits AFTER
      // recorder-ensure and BEFORE recorder-set-session: an
      // ensure-failure persists nothing, and a save-failure aborts
      // before the recorder ever sees the session — persisted state
      // and recorder state stay consistent. Per-stream start failures
      // do not abort Start (4.6 isolation); only channel-level
      // failures do.
      //
      // session-save timeout (open question #2): no client-side timer
      // beyond the platform's. The SW handler is total — every path
      // answers {ok:true} or {ok:false, error} and the listener never
      // throws — so a missing answer means the SW is dead, which
      // surfaces as a rejected sendMessage → the honest
      // 'session-save-failed:no-response' abort below (5.1's
      // channel-failure honesty pattern). A second timer would add a
      // new double-handling failure mode for no benefit.
      channelCall(MSG_ENSURE)
        .then(function (ensureResp) {
          if (!isPlainObject(ensureResp) || ensureResp.ok !== true) {
            var reason = (isPlainObject(ensureResp) &&
              typeof ensureResp.reason === 'string') ?
              ensureResp.reason : 'no-response';
            // Ensure failed BEFORE any session was minted into a stream:
            // abort without the recorder-side clear (nothing to clear).
            setSlots(null, null);
            resetReadiness();
            phase = CONTROL_PHASE_IDLE;
            setButton('Start', true, 'ensure-failed:' + reason,
              'Start recording session');
            // Reject the chain with a sentinel the tail recognizes as
            // "already handled" so it does not double-report.
            throw { handledAbort: true };
          }
          // 5.5 pre-check: after recorder-ensure, before minting. A
          // fresh document (created:true) cannot hold a session, so
          // no query is needed. Otherwise ask the document whether a
          // session is already active — {ok:true} with a sessionId
          // while this tab passed the local interlock means ANOTHER
          // tab holds the session.
          if (isPlainObject(ensureResp) && ensureResp.created === true) {
            return null; // pre-check skipped: fresh document
          }
          // The rejection handler is attached HERE (not at the tail):
          // a dead document cannot hold a session, so no-response
          // proceeds — the atomic guard in the offscreen document
          // remains the correctness arbiter.
          return channelCall(MSG_GET_STATUS).then(null, function () {
            return null;
          });
        })
        .then(function (statusResp) {
          // Pre-check verdict (null when skipped). Refusal aborts
          // BEFORE minting: nothing minted, nothing persisted, no
          // further messages — and crucially no clearRecorderSession,
          // which would wipe the other tab's session. {ok:false} or
          // no-response: proceed — the atomic guard in the offscreen
          // document remains the correctness arbiter (it closes the
          // pre-check's TOCTOU race).
          if (isPlainObject(statusResp) && statusResp.ok === true &&
              typeof statusResp.sessionId === 'string' &&
              statusResp.sessionId !== '') {
            localAbortStart('duplicate-start:session-active');
            throw { handledAbort: true };
          }
          // 5.5: minting moved after recorder-ensure (it used to run
          // synchronously above) so the pre-check aborts before
          // anything is minted.
          if (fieldsHandle !== null) {
            try {
              metadata = BS.createSessionMetadata({
                extensionVersion: opts.extensionVersion,
                protocolVersion: null,
                sessionCategory: sessionCategory
              });
              gameId = BS.newGameId();
              metadata = BS.addGameToSession(metadata, gameId);
              conditions = BS.buildInitialConditions(selection,
                fieldsHandle.getDetectedConditions());
            } catch (e) {
              resetReadiness();
              phase = CONTROL_PHASE_IDLE;
              setButton('Start', true, 'record-build-failed',
                'Start recording session');
              throw { handledAbort: true };
            }
            sessionId = metadata.sessionId;
          } else {
            try {
              sessionId = BS.newSessionId();
              gameId = BS.newGameId();
            } catch (e) {
              // Local-only: the recorder holds no session of ours
              // here (pre-check passed, no set-session sent), so
              // clearRecorderSession would only risk wiping another
              // tab's post-pre-check session.
              localAbortStart('id-mint-failed');
              throw { handledAbort: true };
            }
          }
          if (metadata === null) {
            return null; // 5.1 path: no session-save
          }
          return channelCall(MSG_SESSION_SAVE,
            { metadata: metadata, conditions: conditions });
        })
        .then(function (saveResp) {
          if (metadata !== null) {
            if (!isPlainObject(saveResp) || saveResp.ok !== true) {
              var serr = (isPlainObject(saveResp) &&
                typeof saveResp.error === 'string') ?
                saveResp.error : 'no-response';
              // Save failed BEFORE the recorder ever saw the session:
              // local reset only (nothing to clear recorder-side).
              setSlots(null, null);
              resetReadiness();
              phase = CONTROL_PHASE_IDLE;
              setButton('Start', true, 'session-save-failed:' + serr,
                'Start recording session');
              throw { handledAbort: true };
            }
          }
          var setExtra = { sessionId: sessionId, gameId: gameId };
          if (sessionCategory !== null) {
            // 5.2: the recorder echoes this on recorder-get-status for
            // boot adoption (contract §3.4; 5.1's gameId-echo
            // precedent).
            setExtra.sessionCategory = sessionCategory;
          }
          return channelCall(MSG_SET_SESSION, setExtra);
        })
        .then(function (setResp) {
          if (!isPlainObject(setResp) || setResp.ok !== true) {
            var err = (isPlainObject(setResp) &&
              typeof setResp.error === 'string') ?
              setResp.error : 'no-response';
            if (err === 'session-active') {
              // 5.5: the atomic guard refused — another tab holds the
              // session (the pre-check's TOCTOU race). Local reset
              // ONLY: clearRecorderSession would send
              // set-session{null,null} and wipe their session. The
              // race-loser's session-save record stays as honest raw
              // data (contract §4); §6 tolerates media-less sessions.
              localAbortStart('duplicate-start:session-active');
              throw { handledAbort: true };
            }
            abortStart('set-session-failed:' + err);
            throw { handledAbort: true };
          }
          // Re-arm per-source idempotency for the new game (§5 mints a
          // new game identity → the 3.5.4 comment's seam).
          try {
            opts.gameLifecycleRecorder.resetEnded();
          } catch (e) { /* never break Start on a bookkeeping throw */ }
          return channelCall(MSG_START_STREAMS, {});
        })
        .then(function (startResp) {
          // 4.6 failure isolation, refined against 4.6's actual contract:
          // startStreams() returns top-level ok = all-three-ok, so a
          // top-level {ok:false} WITH a per-stream `streams` object is
          // NOT a channel failure — it is per-stream results, and the
          // session is active (the lights show the truth on the first
          // poll). Only a channel-level failure aborts Start: no
          // response/throw, or {ok:false} WITHOUT a `streams` object
          // (the guard rejections: no-session, start-in-progress,
          // already-started, internal-error).
          var hasStreams = isPlainObject(startResp) &&
            isPlainObject(startResp.streams);
          if (!hasStreams) {
            var err2 = (isPlainObject(startResp) &&
              typeof startResp.error === 'string') ?
              startResp.error : 'no-response';
            abortStart('start-streams-failed:' + err2);
            throw { handledAbort: true };
          }
          // Per-stream failures inside startResp.streams are NOT Start
          // failures (4.6 isolation): the lights will show the truth
          // on the first poll. Remember the per-kind results so a
          // failed start classifies as 'failed-not-started' rather
          // than 'off-idle' (contract §4 adverse facts).
          lastStartResults = {};
          var resStreams = isPlainObject(startResp.streams) ?
            startResp.streams : {};
          for (var si = 0; si < STREAM_KINDS.length; si++) {
            var sk = STREAM_KINDS[si];
            if (isPlainObject(resStreams[sk])) {
              lastStartResults[sk] = resStreams[sk];
            }
          }
          setSlots(sessionId, gameId);
          try {
            BS.emitPageStart(opts.sender, sessionId);
          } catch (e) {
            abortStart('page-start-failed');
            throw { handledAbort: true };
          }
          // 5.6: the initial event emission was observed — the storage
          // side of the readiness policy can now honestly confirm the
          // first acknowledged write (pendingCount drain + no error).
          pageStartEmitted = true;
          phase = CONTROL_PHASE_ACTIVE;
          setButton('Stop', true, null, 'Stop recording session');
          // 5.3: remembered-defaults capture — fired exactly once per
          // successful Start, at the phase → 'active' point, with the
          // selection object that was recorded (the same values
          // session-save persisted). Guarded in try/catch so a
          // throwing callback can never break Start (3.2 SF-1). Null
          // in the 5.1 no-fields path — the 5.3 capture validates and
          // no-ops. Not fired on any abort path, and not fired for
          // boot-adopted sessions (adoption is not a Start: the
          // adoption path below sets the phase directly).
          try {
            opts.onSessionStarted(selection);
          } catch (e) { /* never break Start on the seam */ }
          // 5.2: write-once rule (PLAN 1.2.1 "once at session start"
          // + 5.3 "without silently changing a game's recorded
          // conditions") — the fields are disabled while the session
          // is active; mid-session setSelection is a no-op.
          if (fieldsHandle !== null) {
            try {
              fieldsHandle.setEnabled(false);
            } catch (e) { /* never break Start on the seam */ }
          }
          try {
            pollOnce();
          } catch (e) { /* poll is self-guarding */ }
          schedulePoll();
        })
        .then(null, function (err) {
          // A handled abort already restored idle; anything else is an
          // unexpected channel throw — restore idle honestly rather than
          // stranding the button in "Starting…".
          if (err && err.handledAbort) {
            return;
          }
          abortStart('start-failed');
        });
    }

    // ---- Stop --------------------------------------------------------
    function onStopClick() {
      if (phase === CONTROL_PHASE_IDLE ||
          phase === CONTROL_PHASE_STARTING) {
        return;
      }
      var wasStopping = (phase === CONTROL_PHASE_STOPPING);
      phase = CONTROL_PHASE_STOPPING;
      // The button stays enabled during 'stopping' so a failed stop can
      // be retried; it never silently reverts to idle while the recorder
      // may still hold the session (contract §3.4.5).
      setButton('Stopping…', true, null, 'Stop recording session');

      // 3.5.4 seam: null reason unless a game_ended was already observed
      // for the game, in which case the observed reason/result is passed.
      var termReason = null;
      var termResult = '*';
      try {
        var observed = opts.gameLifecycleRecorder.getLastObservedEnd();
        if (isPlainObject(observed)) {
          termReason = (typeof observed.terminationReason === 'string' ||
            observed.terminationReason === null) ?
            observed.terminationReason : null;
          termResult = (typeof observed.result === 'string' &&
            observed.result !== '') ? observed.result : '*';
        }
      } catch (e) { /* observation failure → null (unknown) */ }
      try {
        opts.gameLifecycleRecorder.recordStopTermination(termReason,
          termResult);
      } catch (e) { /* the Stop must not die on the seam */ }

      channelCall(MSG_STOP_STREAMS)
        .then(function (stopResp) {
          if (!isPlainObject(stopResp) || stopResp.ok !== true) {
            var err = (isPlainObject(stopResp) &&
              typeof stopResp.error === 'string') ?
              stopResp.error : 'no-response';
            // Stop-channel failure: stay in 'stopping' with the honest
            // failure as detail — never silently revert to idle while
            // the recorder may still hold the session.
            setButton('Stopping…', true, 'stop-failed:' + err,
              'Stop recording session (retry)');
            return;
          }
          // One final status poll so the lights reflect the finalized
          // states, then hand the FULL stop response — including
          // flushTimedOut — to 5.10's completion seam (the Section 4
          // audit carry-forward: §5.10 surfaces it; 5.1 must not drop
          // it).
          return pollOnce().then(function () {
            lastStopResponse = stopResp;
            try {
              opts.onStopComplete(stopResp);
            } catch (e) { /* a throwing 5.10 handler must not break us */ }
            stopPolling();
            setSlots(null, null);
            // The observed start results belong to the ended session.
            lastStartResults = {};
            // 5.6: readiness resets with the session.
            resetReadiness();
            phase = CONTROL_PHASE_IDLE;
            setButton('Start', true, null, 'Start recording session');
            // 5.2: the form is re-enabled for the next game. The
            // user's last selection stays in place (5.3 will formalize
            // remembered defaults); an adopted-unknown label is reset
            // to blank by setEnabled(true).
            var fh = resolveFieldsHandle();
            if (fh !== null && fh !== false) {
              try {
                fh.setEnabled(true);
              } catch (e) { /* never break Stop on the seam */ }
            }
            // 5.2: release the recorder-side session now that the
            // stop-stream finalization SUCCEEDED. Without this the
            // recorder keeps reporting {ok:true, sessionId} on
            // get-status, so a page loaded after Stop would adopt a
            // dead (already finalized) session — including a stale
            // sessionCategory echo. Best-effort and failure-safe;
            // a failed stop keeps the session for retry (above).
            clearRecorderSession();
          });
        }, function () {
          setButton('Stopping…', true, 'stop-failed:no-response',
            'Stop recording session (retry)');
        });
      // Note: `wasStopping` documents the retry path for readers; the
      // flow above is identical for first and retry attempts.
      void wasStopping;
    }

    button.addEventListener('click', function () {
      // Never throws into page code (3.2 SF-1).
      try {
        if (phase === CONTROL_PHASE_IDLE) {
          onStartClick();
        } else if (phase === CONTROL_PHASE_ACTIVE ||
                   phase === CONTROL_PHASE_STOPPING) {
          onStopClick();
        }
      } catch (e) { /* unreachable by construction; fail-safe */ }
    });

    // ---- Boot adoption (4.1 refresh survival) -------------------------
    // One recorder-get-status at install: a surviving session is
    // adopted (button → Stop, polling on); {ok:false} → idle.
    // Asynchronous by design — install returns the handle immediately.
    (function bootAdopt() {
      var p;
      try {
        p = channelCall(MSG_GET_STATUS);
      } catch (e) {
        return;
      }
      Promise.resolve(p).then(function (resp) {
        if (stopped || phase !== CONTROL_PHASE_IDLE) {
          return;
        }
        if (!isPlainObject(resp) || resp.ok !== true ||
            typeof resp.sessionId !== 'string' || resp.sessionId === '') {
          return; // no surviving session → idle
        }
        // gameId echo: the 5.1 additive field on the get-status response
        // (open question #2 closure). Absent → null (honest unknown;
        // instrumentation gates emission on a non-empty gameId).
        var gid = (typeof resp.gameId === 'string' && resp.gameId !== '') ?
          resp.gameId : null;
        setSlots(resp.sessionId, gid);
        phase = CONTROL_PHASE_ACTIVE;
        setButton('Stop', true, null, 'Stop recording session');
        // 5.2: the adopted session's category shows in the disabled
        // form (contract §3.4). A missing echo → the honest disabled
        // "Unknown (adopted session)" label — never a remembered
        // default masquerading as the active session's category.
        var afh = resolveFieldsHandle();
        if (afh !== null && afh !== false) {
          try {
            if (typeof afh.showAdoptedCategory === 'function') {
              afh.showAdoptedCategory(
                (typeof resp.sessionCategory === 'string' &&
                 resp.sessionCategory !== '') ? resp.sessionCategory : null);
            } else {
              afh.setEnabled(false);
            }
          } catch (e) { /* never break adoption on the seam */ }
        }
        applyStatusResponse(resp.statuses);
        schedulePoll();
      }, function () { /* no surviving session → idle */ });
    })();

    return {
      element: cluster,
      button: button,
      lights: lights,
      getPhase: function () { return phase; },
      getSession: function () {
        return { sessionId: activeSessionId, gameId: activeGameId };
      },
      getLastStopResponse: function () { return lastStopResponse; },
      stop: function () {
        stopped = true;
        stopPolling();
      }
    };
  }

  BlindfoldSession.LIGHT_OFF_IDLE = LIGHT_OFF_IDLE;
  BlindfoldSession.LIGHT_FAILED_NOT_STARTED = LIGHT_FAILED_NOT_STARTED;
  BlindfoldSession.LIGHT_RECORDING_HEALTHY = LIGHT_RECORDING_HEALTHY;
  BlindfoldSession.LIGHT_RECORDING_DEGRADED = LIGHT_RECORDING_DEGRADED;
  BlindfoldSession.LIGHT_STOPPED_FINALIZING = LIGHT_STOPPED_FINALIZING;
  BlindfoldSession.LIGHT_FINALIZED = LIGHT_FINALIZED;
  BlindfoldSession.LIGHT_UNKNOWN = LIGHT_UNKNOWN;
  BlindfoldSession.SESSION_CONTROL_STREAM_KINDS = STREAM_KINDS;
  BlindfoldSession.SESSION_CONTROL_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
  BlindfoldSession.RECORDER_MSG_ENSURE = MSG_ENSURE;
  BlindfoldSession.RECORDER_MSG_SESSION_SAVE = MSG_SESSION_SAVE;
  BlindfoldSession.classifyStreamStatus = classifyStreamStatus;
  // 5.6: readiness policy (PLAN.md §5.6).
  BlindfoldSession.READINESS_READY = READINESS_READY;
  BlindfoldSession.READINESS_NOT_READY = READINESS_NOT_READY;
  BlindfoldSession.READINESS_UNKNOWN = READINESS_UNKNOWN;
  BlindfoldSession.computeReadiness = computeReadiness;
  BlindfoldSession.installSessionControls = installSessionControls;
})();

// Node test shim. Content-script consumers use the BlindfoldSession global
// directly; only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
