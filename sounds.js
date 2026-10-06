let last_spoken_move_text = null;
let speech_timestamp = 0;
let current_utterance = null;

const illegal_move_audio = (typeof Audio !== 'undefined' && typeof chrome !== 'undefined' &&
  chrome.runtime && typeof chrome.runtime.getURL === 'function')
  ? new Audio(chrome.runtime.getURL("illegal_move.wav"))
  : null;
if (illegal_move_audio) illegal_move_audio.preload = "auto";

function playIllegalMoveSound() {
  if (!illegal_move_audio) return;
  illegal_move_audio.currentTime = 0;
  illegal_move_audio.play().catch(() => {});
}

// 3.4: the instrumented speech functions route through the tracker
// installed by content.js (BlindfoldSession.speechTracker). Failure-
// isolated (3.2 SF-1 precedent): if the tracker is absent or throws,
// fall back to direct speechSynthesis so speech never breaks.
function getSpeechTracker() {
  try {
    if (typeof BlindfoldSession !== 'undefined' && BlindfoldSession.speechTracker) {
      return BlindfoldSession.speechTracker;
    }
  } catch (e) { /* fall through */ }
  return null;
}

function speakText(text, { interrupt = true, rate = 1, link = null, saveText = null } = {}) {
  if (!("speechSynthesis" in window)) return;
  if (!text) return;
  var tracker = getSpeechTracker();
  if (tracker) {
    try {
      if (interrupt) tracker.cancelRequested('interrupt-replace');
      tracker.speak(text, { rate: rate, link: link, saveText: saveText });
      return;
    } catch (e) { /* fall through to direct speech */ }
  }
  if (interrupt) speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  current_utterance = utterance;

  utterance.rate = rate;
  utterance.pitch = 1;
  utterance.volume = 1;

  speechSynthesis.speak(utterance);
}

function speakTextAsync(text, { interrupt = false, rate = 1, link = null } = {}) {
  return new Promise((resolve) => {
    if (!text) return resolve();
    var tracker = getSpeechTracker();
    if (tracker) {
      try {
        if (interrupt) tracker.cancelRequested('interrupt-replace');
        // 3.4 §2.4: the promise resolves on end AND error exactly as
        // today — the tracker's onDone fires for every outcome.
        tracker.speak(text, { rate: rate, link: link, onDone: function () { resolve(); } });
        return;
      } catch (e) { /* fall through to direct speech */ }
    }
    if (interrupt) speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(String(text));
    current_utterance = utterance;
    utterance.rate = rate;

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();

    speechSynthesis.speak(utterance);
  });
}

function announceResultIfOver(link) {
  const text = getResultAnnouncement(game);
  if (!text) return;
  speakText(text, { interrupt: false, link: link || null });
}

function getResultAnnouncement(game) {
  if (!game.game_over()) return null;

  if (game.in_checkmate()) {
    const winner = game.turn() === "w" ? "Black" : "White";
    return `Checkmate. ${winner} wins.`;
  }

  if (game.in_stalemate()) return "Draw by stalemate.";
  if (game.in_threefold_repetition()) return "Draw by threefold repetition.";
  if (game.insufficient_material()) return "Draw by insufficient material.";

  if (game.in_draw()) return "Draw.";
  return "Game over.";
}

function sayMove(game_before_move, san_move, link) {
  if (!san_move) return;
  const spoken_move_text = sanToSpeech(game_before_move, san_move);
  if (!spoken_move_text) return;
  last_spoken_move_text = spoken_move_text;
  speakText(spoken_move_text, { interrupt: true, link: link || null });
}

function sanToSpeech(game_before_move, san_move) {
  if (!san_move) return "";

  const game_copy = new Chess(game_before_move.fen());
  const move = game_copy.move(san_move);

  if (!move) return String(san_move).split("").join(". ");

  if (move.san === "O-O") return "castle king side";
  if (move.san === "O-O-O") return "castle queen side";

  const parts = [];

  const is_capture = !!move.captured;
  const to_sq = squareToSpeech(move.to);

  if (move.piece === "p") {
    if (is_capture) {
      const from_file = move.from[0];
      parts.push(`${from_file}. takes ${to_sq}`);

      if (move.flags && move.flags.includes("e")) {
        parts.push("en passant");
      }
    } else {
      parts.push(`${to_sq}`);
    }
  } else {
    const piece = pieceLetterToName(move.piece);
    const disambiguation = getDisambiguation(move);

    if (is_capture) parts.push(`${piece} ${disambiguation}takes ${to_sq}`);
    else parts.push(`${piece} ${disambiguation}to ${to_sq}`);
  }

  if (move.promotion) {
    const promo = pieceLetterToName(move.promotion);
    parts.push(`promotes to ${promo}`);
  }

  if (move.san.includes("#")) parts.push("checkmate");
  else if (move.san.includes("+")) parts.push("check");

  return parts.join(", ").replace(/\s+/g, " ").trim();
}

function pieceLetterToName(letter) {
  switch (letter) {
    case "p":
      return "pawn";
    case "n":
      return "knight";
    case "b":
      return "bishop";
    case "r":
      return "rook";
    case "q":
      return "queen";
    case "k":
      return "king";
    default:
      return "piece";
  }
}

function squareToSpeech(square) {
  if (!square || square.length !== 2) return String(square || "");
  return `${square[0]}. ${square[1]}`;
}

function getDisambiguation(move) {
  if (!move || !move.from || !move.to || !move.san) return "";

  const from_file = move.from[0];
  const from_rank = move.from[1];

  let raw = move.san;

  raw = raw.replace(/[+#]$/, "");
  raw = raw.replace(/=[NBRQ]/, "");
  raw = raw.replace(/x/g, "");
  raw = raw.replace(/^[NBRQK]/, "");
  raw = raw.replace(move.to, "");

  if (raw === from_file) return `${from_file} `;
  if (raw === from_rank) return `${from_rank} `;
  if (raw === from_file + from_rank) return `${from_file} ${from_rank} `;
  return "";
}

async function speakFullMoveList(half_moves, link) {
  if (!half_moves || half_moves.length === 0) {
    speakText("No moves yet.", { interrupt: true, link: link || null });
    return;
  }

  speech_timestamp = speech_timestamp + 1;
  const timestamp = speech_timestamp;

  const temp_game = new Chess();
  const lines = ["Move list:"];

  for (let i = 0; i < half_moves.length; i += 2) {
    const move_num = Math.floor(i / 2) + 1;

    const white_move = half_moves[i];
    const white_move_text = white_move
      ? sanToSpeech(temp_game, white_move)
      : "";
    if (white_move) temp_game.move(white_move);

    const black_move = half_moves[i + 1];
    const black_move_text = black_move
      ? sanToSpeech(temp_game, black_move)
      : "";
    if (black_move) temp_game.move(black_move);

    let line = `${move_num}. ${white_move_text}.`;
    if (black_move) {
      line += `. ${black_move_text}.`;
    }
    lines.push(line);
  }

  // 3.4.1: each move-list line links the same helpRequestEventId (the
  // i-shortcut request). The timestamp-guard abandonment below is NOT a
  // cancel (no cancel() call) and records nothing — documented in §2.2.
  await speakTextAsync(lines[0], { interrupt: true, rate: 0.9, link: link || null });
  if (timestamp !== speech_timestamp) return;

  for (let i = 1; i < lines.length; i++) {
    await speakTextAsync(lines[i], { interrupt: false, rate: 0.9, link: link || null });
    if (timestamp !== speech_timestamp) return;
  }
}

function stopAllSpeech() {
  speech_timestamp = speech_timestamp + 1;
  // 3.4.3: the Escape path records utterance_cancel_requested per
  // in-flight utterance (source 'user'). Failure-isolated.
  var tracker = getSpeechTracker();
  if (tracker) {
    try {
      tracker.cancelRequested('user');
      return;
    } catch (e) { /* fall through to direct cancel */ }
  }
  speechSynthesis.cancel();
}
function getPieceCodeFromClassList(class_list) {
  for (const c of class_list) {
    if (/^[wb][prnbqk]$/.test(c)) return c;
  }
  return null;
}

function getSquareClassFromClassList(class_list) {
  for (const c of class_list) {
    if (/^square-\d\d$/.test(c)) return c;
  }
  return null;
}

function squareClassToSquare(square_class) {
  const square_match = /^square-(\d)(\d)$/.exec(square_class);
  if (!square_match) return null;
  const file = digitToFile(square_match[1]);
  const rank = square_match[2];
  return file + rank;
}

function digitToFile(digit) {
  return "abcdefgh"[Number(digit) - 1] || "?";
}

function getSquaresSpokenText(squares) {
  const spoken_squares = squares.map(squareToSpeech);
  if (spoken_squares.length == 0) return "";
  if (spoken_squares.length == 1) return spoken_squares[0];
  if (spoken_squares.length == 2) return `${spoken_squares[0]} and ${spoken_squares[1]}`;
  return `${spoken_squares.slice(0, -1).join(", ")}, and ${spoken_squares[spoken_squares.length - 1]}`
}

function pluralizePiece(name, count) {
  if (count == 1) return name;
  return `${name}s`;
}

function readPiecesFromBoardDOM() {
  let board = document.querySelector("#board-primary");
  if (!board) board = document.querySelector("#board-play-computer");
  if (!board) return null;

  const piece_elements = board.querySelectorAll(".piece");

  const piece_squares = {
    w: { k: [], p: [], n: [], b: [], r: [], q: [] },
    b: { k: [], p: [], n: [], b: [], r: [], q: [] }
  };

  for (const piece_element of piece_elements) {
    const piece_code = getPieceCodeFromClassList(piece_element.classList);
    const square_class = getSquareClassFromClassList(piece_element.classList);
    if (!piece_code || !square_class) continue;

    const color = piece_code[0];
    const type = piece_code[1];
    const square = squareClassToSquare(square_class);
    if (!square) continue;

    piece_squares[color][type].push(square);
  }

  for (const color of ["w", "b"]) {
    for (const type of Object.keys(piece_squares[color])) {
      piece_squares[color][type].sort();
    }
  }

  return piece_squares;
}

function piecesToSpeechText(side_piece_squares, side) {
  const pieces = ["k", "p", "n", "b", "r", "q"];
  const parts = [];

  for (const piece of pieces) {
    const squares = side_piece_squares[piece];
    if (!squares || squares.length === 0) continue;

    const piece_name = pieceLetterToName(piece);
    const pluralized_piece_name = pluralizePiece(piece_name, squares.length);
    parts.push(`${pluralized_piece_name} on ${getSquaresSpokenText(squares)}`);
  }

  if (parts.length === 0) return `${side} pieces: None.`;
  return `${side} pieces: ${parts.join("; ")}`;
}

function positionToSpeechText() {
  const data = readPiecesFromBoardDOM();
  if (!data) return "Board not found.";

  const white_pieces_speech = piecesToSpeechText(data.w, "White");
  const black_pieces_speech = piecesToSpeechText(data.b, "Black");

  return `${black_pieces_speech}. ${white_pieces_speech}`;
}

function speakPosition(link) {
  // 3.4.4 opt-in: when the board DOM is missing, the spoken text is a
  // DOM-observation failure ("Board not found.") that cannot be
  // reproduced from any event — save it verbatim. All other position
  // readouts are reproducible from FEN + positionToSpeechText.
  var boardMissing = readPiecesFromBoardDOM() === null;
  var text = positionToSpeechText();
  speakText(text, {
    interrupt: true,
    rate: 0.7,
    link: link || null,
    saveText: boardMissing ? text : null
  });
}

// ------------------------------------------------------------------
// Task 3.4 (PLAN.md §3.4): speech utterance instrumentation.
//
// The guarded namespace + Node shim (3.1/3.2/3.3 precedent). The
// pre-existing global speech functions above keep working unchanged;
// the tracker factory, validators, and constants live on
// BlindfoldSession for namespaced access and testability.
var BlindfoldSession = BlindfoldSession || {};

// 3.4-owned event vocabulary (1.3 §2.2: each task owns its vocabulary).
// event_envelope.js is untouched — EVENT_TYPE_RE accepts these.
BlindfoldSession.UTTERANCE_STARTED_EVENT_TYPE = 'utterance_started';
BlindfoldSession.UTTERANCE_ENDED_EVENT_TYPE = 'utterance_ended';
BlindfoldSession.UTTERANCE_CANCEL_REQUESTED_EVENT_TYPE = 'utterance_cancel_requested';
BlindfoldSession.SPEECH_SETTINGS_EVENT_TYPE = 'speech_settings';

// 3.4.4: versioned speech logic. Bump rule (DECISIONS.md): any change to
// sanToSpeech, getResultAnnouncement, positionToSpeechText,
// getDisambiguation, or the shortcut text templates requires bumping
// this version — otherwise analysts cannot replay historical utterances
// from the linked events.
BlindfoldSession.SPEECH_LOGIC_VERSION = '1';

BlindfoldSession.UTTERANCE_TRIGGERS = Object.freeze(['move', 'help-request', 'game-result']);
BlindfoldSession.UTTERANCE_END_OUTCOMES = Object.freeze(['completed', 'cancelled', 'error']);
BlindfoldSession.CANCEL_SOURCES = Object.freeze(['user', 'interrupt-replace']);

// §5-owned runtime slot (2.7/3.1/3.2/3.3 precedent). content.js installs
// the tracker after creating it; the speech functions below use it when
// present and fall back to direct speechSynthesis otherwise.
BlindfoldSession.speechTracker = null;

var UUID_V4_RE_34 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireExactKeys34(obj, keys, what) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TypeError(what + ' must be a plain object');
  }
  var actual = Object.keys(obj).sort();
  var expected = keys.slice().sort();
  if (actual.length !== expected.length ||
      actual.some(function (k, i) { return k !== expected[i]; })) {
    throw new TypeError(what + ' must have exactly the keys: ' + expected.join(', '));
  }
  return obj;
}

function requireUuidV4_34(value, what) {
  if (typeof value !== 'string' || !UUID_V4_RE_34.test(value)) {
    throw new TypeError(what + ' must be a uuid-v4 string');
  }
  return value;
}

// Prefer the merged test namespace (3.1 sharedBS precedent) so
// BlindfoldSession.newEventId resolves in Node tests where each file
// has its own local namespace object.
function sharedBS34() {
  if (typeof globalThis !== 'undefined' && globalThis.BlindfoldSession &&
      typeof globalThis.BlindfoldSession.newEventId === 'function') {
    return globalThis.BlindfoldSession;
  }
  return BlindfoldSession;
}

// 3.4 validators: exact keys; TypeError = wrong type/shape,
// RangeError = bad enum/domain value (AGENTS.md convention).
function requireValidUtteranceStartedPayload(payload) {
  requireExactKeys34(payload,
    ['utteranceId', 'trigger', 'speechLogicVersion', 'rate', 'pitch', 'volume', 'voiceName', 'text'],
    'utterance_started payload');
  requireUuidV4_34(payload.utteranceId, 'utterance_started payload.utteranceId');
  if (BlindfoldSession.UTTERANCE_TRIGGERS.indexOf(payload.trigger) === -1) {
    throw new RangeError('utterance_started payload.trigger must be a member of UTTERANCE_TRIGGERS');
  }
  if (typeof payload.speechLogicVersion !== 'string' || payload.speechLogicVersion === '') {
    throw new TypeError('utterance_started payload.speechLogicVersion must be a non-empty string');
  }
  for (const k of ['rate', 'pitch', 'volume']) {
    if (typeof payload[k] !== 'number' || !(payload[k] > 0)) {
      throw new RangeError('utterance_started payload.' + k + ' must be a positive number');
    }
  }
  if (payload.voiceName !== null && typeof payload.voiceName !== 'string') {
    throw new TypeError('utterance_started payload.voiceName must be a string or null');
  }
  // 3.4.4: text is saved only when the call site opts in (it cannot be
  // reproduced from the linked event + versioned speech logic).
  if (payload.text !== null && typeof payload.text !== 'string') {
    throw new TypeError('utterance_started payload.text must be a string or null');
  }
  return payload;
}

function requireValidUtteranceStartedRefs(refs) {
  // Exactly one link ref (1.3 camelCase Id-role convention): the
  // utterance is always linked to its move, help request, or (via the
  // terminal move) game-result event. Sparse form — a single key —
  // because the sender's requireRefs (event_envelope.js, untouchable)
  // rejects null ref values.
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) {
    throw new TypeError('utterance_started refs must be a plain object');
  }
  var keys = Object.keys(refs);
  if (keys.length !== 1 ||
      (keys[0] !== 'moveEventId' && keys[0] !== 'helpRequestEventId')) {
    throw new TypeError('utterance_started refs must be exactly one of {moveEventId} / {helpRequestEventId}');
  }
  requireUuidV4_34(refs[keys[0]], 'utterance_started refs.' + keys[0]);
  return refs;
}

function requireValidUtteranceEndedPayload(payload) {
  requireExactKeys34(payload, ['utteranceId', 'outcome', 'cancelSource', 'errorName'],
    'utterance_ended payload');
  requireUuidV4_34(payload.utteranceId, 'utterance_ended payload.utteranceId');
  if (BlindfoldSession.UTTERANCE_END_OUTCOMES.indexOf(payload.outcome) === -1) {
    throw new RangeError('utterance_ended payload.outcome must be a member of UTTERANCE_END_OUTCOMES');
  }
  if (payload.cancelSource !== null &&
      BlindfoldSession.CANCEL_SOURCES.indexOf(payload.cancelSource) === -1) {
    throw new RangeError('utterance_ended payload.cancelSource must be a member of CANCEL_SOURCES or null');
  }
  if (payload.errorName !== null && typeof payload.errorName !== 'string') {
    throw new TypeError('utterance_ended payload.errorName must be a string or null');
  }
  return payload;
}

function requireValidUtteranceCancelRequestedPayload(payload) {
  requireExactKeys34(payload, ['utteranceId', 'source'],
    'utterance_cancel_requested payload');
  requireUuidV4_34(payload.utteranceId, 'utterance_cancel_requested payload.utteranceId');
  if (BlindfoldSession.CANCEL_SOURCES.indexOf(payload.source) === -1) {
    throw new RangeError('utterance_cancel_requested payload.source must be a member of CANCEL_SOURCES');
  }
  return payload;
}

function requireValidSpeechSettingsPayload(payload) {
  requireExactKeys34(payload, ['voiceName', 'voiceCount', 'rate', 'pitch', 'volume'],
    'speech_settings payload');
  if (payload.voiceName !== null && typeof payload.voiceName !== 'string') {
    throw new TypeError('speech_settings payload.voiceName must be a string or null');
  }
  if (!Number.isInteger(payload.voiceCount) || payload.voiceCount < 0) {
    throw new RangeError('speech_settings payload.voiceCount must be a non-negative integer');
  }
  for (const k of ['rate', 'pitch', 'volume']) {
    if (typeof payload[k] !== 'number' || !(payload[k] > 0)) {
      throw new RangeError('speech_settings payload.' + k + ' must be a positive number');
    }
  }
  return payload;
}

BlindfoldSession.requireValidUtteranceStartedPayload = requireValidUtteranceStartedPayload;
BlindfoldSession.requireValidUtteranceStartedRefs = requireValidUtteranceStartedRefs;
BlindfoldSession.requireValidUtteranceEndedPayload = requireValidUtteranceEndedPayload;
BlindfoldSession.requireValidUtteranceCancelRequestedPayload = requireValidUtteranceCancelRequestedPayload;
BlindfoldSession.requireValidSpeechSettingsPayload = requireValidSpeechSettingsPayload;

// ------------------------------------------------------------------
// Task 3.4: createSpeechTracker — utterance lifecycle instrumentation.
//
// DOM-free factory (3.1/3.2/3.3 recorder precedent). The tracker's
// speak(text, opts) is the single choke point the instrumented speech
// functions call. opts: { rate, pitch, volume, link, saveText, onDone }.
// link = { trigger, moveEventId?, helpRequestEventId? } — exactly one
// of the two event IDs must be a non-null string for the started event
// to be emitted (3.4.1's link requirement); without a valid link the
// utterance is still spoken and tracked (cancel correlation works) but
// no utterance_started is emitted.
//
// Emission is gated on non-empty sessionId AND gameId via thunks
// (2.7/3.1/3.2/3.3 §5-seam precedent) — pre-§5 the tracker is inert:
// speech proceeds normally, no events, link IDs are null.
//
// Failure isolation (3.2 SF-1 precedent): every tracker call from a
// speech path is wrapped by the caller so instrumentation can never
// break speech, throw into page code, or reject unhandled. The tracker
// itself also never throws out of speak/cancelRequested/onDone paths
// except for programmer errors (bad options types).
// ------------------------------------------------------------------
function createSpeechTracker(options) {
  var opts = options || {};
  var getSessionId = opts.getSessionId;
  var getGameId = opts.getGameId;
  var emitEvent = opts.emitEvent;
  var BS = BlindfoldSession;
  if (typeof getSessionId !== 'function') {
    throw new TypeError('createSpeechTracker getSessionId must be a function');
  }
  if (typeof getGameId !== 'function') {
    throw new TypeError('createSpeechTracker getGameId must be a function');
  }
  if (typeof emitEvent !== 'function') {
    throw new TypeError('createSpeechTracker emitEvent must be a function');
  }
  // Injected speech primitives (DOM-free testability). Defaults use the
  // real speechSynthesis; callers may omit them in the browser.
  var speakFn = (typeof opts.speak === 'function') ? opts.speak : function (u) {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.speak(u);
  };
  var cancelFn = (typeof opts.cancel === 'function') ? opts.cancel : function () {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  };
  var getVoicesFn = (typeof opts.getVoices === 'function') ? opts.getVoices : function () {
    try {
      return (typeof speechSynthesis !== 'undefined') ? speechSynthesis.getVoices() : [];
    } catch (e) { return []; }
  };
  var newUtteranceFn = (typeof opts.newUtterance === 'function') ? opts.newUtterance : function (t) {
    return new SpeechSynthesisUtterance(t);
  };

  function isActive() {
    var sid = getSessionId();
    var gid = getGameId();
    return typeof sid === 'string' && sid !== '' &&
           typeof gid === 'string' && gid !== '';
  }

  function eventIdOf(result) {
    return (result && typeof result.eventId === 'string') ? result.eventId : null;
  }

  function newUtteranceId() {
    // 1.3's single private UUID source (contract §2.2); sharedBS resolves
    // it in Node tests where each file has its own local namespace.
    return sharedBS34().newEventId();
  }

  var settingsEmitted = false;
  var inFlight = {}; // utteranceId -> entry
  var inFlightCount = 0;

  function voiceNameOf(utterance) {
    try {
      if (utterance && utterance.voice && typeof utterance.voice.name === 'string') {
        return utterance.voice.name;
      }
    } catch (e) { /* best-effort */ }
    return null; // default voice; name unknown
  }

  function getVoiceList() {
    try {
      var v = getVoicesFn();
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  // 3.4.5: the one-time baseline. Per-utterance rate/pitch/volume/
  // voiceName on every utterance_started covers subsequent changes.
  function emitSettingsOnce(utterance) {
    if (settingsEmitted) return;
    settingsEmitted = true;
    var payload = requireValidSpeechSettingsPayload({
      voiceName: voiceNameOf(utterance),
      voiceCount: getVoiceList().length,
      rate: utterance.rate,
      pitch: utterance.pitch,
      volume: utterance.volume
    });
    emitEvent(BS.SPEECH_SETTINGS_EVENT_TYPE, payload, null);
  }

  function normalizeLink(link) {
    if (!link || typeof link !== 'object') return null;
    if (BS.UTTERANCE_TRIGGERS.indexOf(link.trigger) === -1) return null;
    var moveEventId = (typeof link.moveEventId === 'string') ? link.moveEventId : null;
    var helpRequestEventId = (typeof link.helpRequestEventId === 'string') ? link.helpRequestEventId : null;
    // Exactly one link ref (mirrors requireValidUtteranceStartedRefs):
    // sparse single-key form, since the sender's requireRefs rejects
    // null ref values (event_envelope.js is untouchable).
    if ((moveEventId !== null) === (helpRequestEventId !== null)) return null;
    var refs = (moveEventId !== null)
      ? { moveEventId: moveEventId }
      : { helpRequestEventId: helpRequestEventId };
    try {
      requireValidUtteranceStartedRefs(refs);
    } catch (e) {
      return null;
    }
    return { trigger: link.trigger, refs: refs };
  }

  function speak(text, speakOpts) {
    var o = speakOpts || {};
    var utteranceId = newUtteranceId();
    var utterance = newUtteranceFn(text);
    utterance.rate = (typeof o.rate === 'number') ? o.rate : 1;
    utterance.pitch = (typeof o.pitch === 'number') ? o.pitch : 1;
    utterance.volume = (typeof o.volume === 'number') ? o.volume : 1;

    var entry = {
      utteranceId: utteranceId,
      cancelRequested: false,
      cancelSource: null,
      startedEmitted: false,
      onDone: (typeof o.onDone === 'function') ? o.onDone : null
    };
    inFlight[utteranceId] = entry;
    inFlightCount++;

    function finish(outcome, errorName) {
      if (!inFlight[utteranceId]) return; // already finished
      delete inFlight[utteranceId];
      inFlightCount--;
      // utterance_ended is only meaningful if utterance_started was
      // recorded (unlinked utterances still get cancel correlation via
      // utterance_cancel_requested, which needs no link).
      if (entry.startedEmitted && isActive()) {
        try {
          emitEvent(BS.UTTERANCE_ENDED_EVENT_TYPE,
            requireValidUtteranceEndedPayload({
              utteranceId: utteranceId,
              outcome: outcome,
              cancelSource: entry.cancelSource,
              errorName: (errorName === undefined || errorName === null) ? null : String(errorName)
            }),
            null);
        } catch (e) { /* instrumentation must never throw */ }
      }
      if (entry.onDone) {
        try { entry.onDone(outcome); } catch (e) { /* never throw */ }
      }
    }

    // 3.4.2/3.4.3: correlate the callback with the cancel request —
    // never trust the callback name alone. onend after a recorded
    // cancel request → 'cancelled', not 'completed'.
    utterance.onend = function () {
      finish(entry.cancelRequested ? 'cancelled' : 'completed', null);
    };
    utterance.onerror = function (ev) {
      var rawName = (ev && typeof ev.error === 'string') ? ev.error : 'unknown-error';
      if (entry.cancelRequested) {
        finish('cancelled', null);
      } else {
        finish('error', rawName);
      }
    };

    var normalized = normalizeLink(o.link);
    if (normalized !== null && isActive()) {
      try {
        emitSettingsOnce(utterance);
        emitEvent(BS.UTTERANCE_STARTED_EVENT_TYPE,
          requireValidUtteranceStartedPayload({
            utteranceId: utteranceId,
            trigger: normalized.trigger,
            speechLogicVersion: BS.SPEECH_LOGIC_VERSION,
            rate: utterance.rate,
            pitch: utterance.pitch,
            volume: utterance.volume,
            voiceName: voiceNameOf(utterance),
            // 3.4.4: null unless the call site opts in.
            text: (typeof o.saveText === 'string') ? o.saveText : null
          }),
          normalized.refs);
        entry.startedEmitted = true;
      } catch (e) { /* instrumentation must never throw */ }
    }

    try {
      speakFn(utterance);
    } catch (e) {
      // The speak primitive should never throw; if it does, finish as
      // an error so the in-flight set cannot leak.
      finish('error', 'speak-threw');
    }
    return utteranceId;
  }

  // 3.4.3: every call to the cancel primitive records
  // utterance_cancel_requested for EACH in-flight utterance — the
  // request is recorded even if callbacks never fire. source:
  // 'user' (Escape / stopAllSpeech) vs 'interrupt-replace' (a new
  // utterance preempting). The timestamp-guard abandonment in
  // speakFullMoveList is NOT a cancel (no cancel() call) and records
  // nothing.
  function cancelRequested(source) {
    if (BS.CANCEL_SOURCES.indexOf(source) === -1) {
      throw new RangeError('cancelRequested source must be a member of CANCEL_SOURCES');
    }
    var ids = Object.keys(inFlight);
    for (var i = 0; i < ids.length; i++) {
      var entry = inFlight[ids[i]];
      entry.cancelRequested = true;
      entry.cancelSource = source;
      if (isActive()) {
        try {
          emitEvent(BS.UTTERANCE_CANCEL_REQUESTED_EVENT_TYPE,
            requireValidUtteranceCancelRequestedPayload({
              utteranceId: entry.utteranceId,
              source: source
            }),
            null);
        } catch (e) { /* instrumentation must never throw */ }
      }
    }
    try {
      cancelFn();
    } catch (e) { /* instrumentation must never throw */ }
  }

  function inFlightIds() {
    return Object.keys(inFlight);
  }

  return {
    speak: speak,
    cancelRequested: cancelRequested,
    isActive: isActive,
    inFlightCount: function () { return inFlightCount; },
    inFlightIds: inFlightIds
  };
}

BlindfoldSession.createSpeechTracker = createSpeechTracker;

// Node shim (3.1/3.2/3.3 precedent): the factory, validators, and
// constants are importable; the pre-existing global speech functions
// stay globals and keep working unchanged in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
