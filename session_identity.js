// session_identity.js
//
// Task 1.1 (PLAN.md §1.1.1–§1.1.3): session and game identity factories.
//
// Dependency-free plain script. Loads as a content-script global, via
// importScripts() in a future MV3 service worker, or under Node via the
// module.exports shim at the end. Platform-independent by design: call sites
// inject the extension version (from the extension manifest); this module
// never touches extension APIs itself.
//
// Identity semantics:
// - One sessionId per recording session (created at Start).
// - One gameId per detected game. metadata.gameIds is an ordered array, so a
//   second detected game (shared recording session, PLAN §5.9) appends a new
//   ID rather than replacing or mixing histories. Length > 1 implicitly marks
//   a shared-recording session — no extra flag, it is derivable.
// - IDs are UUID v4 from crypto.randomUUID(). No fallback: if the Web Crypto
//   API is unavailable the factory throws instead of fabricating weak IDs
//   from a non-cryptographic source, which would silently weaken uniqueness.

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  var SCHEMA_VERSION = '1.0.0';
  var SESSION_CATEGORIES = Object.freeze(['baseline', 'training', 'evaluation']);
  var UUID_V4_RE = Object.freeze(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );

  function webCrypto() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto) {
      return globalThis.crypto;
    }
    return null;
  }

  // Single private UUID source. newSessionId and newGameId are independent
  // exported functions (not aliases) so the two streams stay separable.
  function newUuid() {
    var cryptoObj = webCrypto();
    if (!cryptoObj || typeof cryptoObj.randomUUID !== 'function') {
      throw new Error(
        'BlindfoldSession: crypto.randomUUID() is unavailable in this environment'
      );
    }
    return cryptoObj.randomUUID();
  }

  function newSessionId() { return newUuid(); }

  function newGameId() { return newUuid(); }

  function isUuidV4(s) {
    return typeof s === 'string' && UUID_V4_RE.test(s);
  }

  function isSessionCategory(s) {
    return typeof s === 'string' && SESSION_CATEGORIES.indexOf(s) !== -1;
  }

  // User-maintained experiment protocol version (PLAN §3(b)). Trimmed
  // non-empty string → itself; null/undefined/empty/whitespace-only → null
  // (unknown stays unknown, never guessed, never ""). Non-string non-null
  // input is a caller error.
  function normalizeProtocolVersion(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') {
      throw new TypeError('protocolVersion must be a string or null');
    }
    var trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  }

  function requireValidMetadata(metadata) {
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('metadata must be a session metadata object');
    }
    if (!isUuidV4(metadata.sessionId)) {
      throw new TypeError('metadata.sessionId must be a uuid-v4 string');
    }
    if (!Array.isArray(metadata.gameIds) || !metadata.gameIds.every(isUuidV4)) {
      throw new TypeError('metadata.gameIds must be an array of uuid-v4 strings');
    }
    if (metadata.schemaVersion !== SCHEMA_VERSION) {
      throw new TypeError('metadata.schemaVersion is not the current schema version');
    }
    if (typeof metadata.extensionVersion !== 'string' ||
        metadata.extensionVersion.trim() === '') {
      throw new TypeError('metadata.extensionVersion must be a non-empty string');
    }
    if (metadata.protocolVersion !== null &&
        typeof metadata.protocolVersion !== 'string') {
      throw new TypeError('metadata.protocolVersion must be a string or null');
    }
    if (!isSessionCategory(metadata.sessionCategory)) {
      throw new RangeError('metadata.sessionCategory must be one of the session categories');
    }
  }

  // Creates a fresh session metadata record. gameIds starts empty: session
  // identity is created at Start while game detection may lag — fabricating
  // a game ID before a game is detected would misrepresent evidence.
  // The returned record (and its gameIds array) is frozen: identity records
  // are append-only, so caller-side mutation is a bug, not a feature.
  function createSessionMetadata(options) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    var extensionVersion = options.extensionVersion;
    if (typeof extensionVersion !== 'string' || extensionVersion.trim() === '') {
      throw new TypeError('extensionVersion must be a non-empty string');
    }
    var sessionCategory = options.sessionCategory;
    if (!isSessionCategory(sessionCategory)) {
      throw new RangeError(
        'sessionCategory must be one of: ' + SESSION_CATEGORIES.join(', ')
      );
    }
    var record = {
      sessionId: newUuid(),
      gameIds: [],
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: extensionVersion.trim(),
      protocolVersion: normalizeProtocolVersion(options.protocolVersion),
      sessionCategory: sessionCategory
    };
    Object.freeze(record.gameIds);
    return Object.freeze(record);
  }

  // Appends a game ID to the session record. Pure: the input record is never
  // mutated; a new (frozen) record with exactly the six keys is returned.
  // When gameId is omitted (undefined or null) a fresh one is generated.
  // A duplicate explicit gameId is a detection bug, not a second game:
  // throwing keeps it visible as evidence instead of silently corrupting
  // the "unique IDs establish identity" invariant (PLAN §3(a)).
  function addGameToSession(metadata, gameId) {
    requireValidMetadata(metadata);
    var id = (gameId === undefined || gameId === null) ? newUuid() : gameId;
    if (!isUuidV4(id)) {
      throw new TypeError('gameId must be a uuid-v4 string');
    }
    if (metadata.gameIds.indexOf(id) !== -1) {
      throw new Error('gameId is already present in this session record');
    }
    var record = {
      sessionId: metadata.sessionId,
      gameIds: metadata.gameIds.concat([id]),
      schemaVersion: metadata.schemaVersion,
      extensionVersion: metadata.extensionVersion,
      protocolVersion: metadata.protocolVersion,
      sessionCategory: metadata.sessionCategory
    };
    Object.freeze(record.gameIds);
    return Object.freeze(record);
  }

  BlindfoldSession.SCHEMA_VERSION = SCHEMA_VERSION;
  BlindfoldSession.SESSION_CATEGORIES = SESSION_CATEGORIES;
  BlindfoldSession.UUID_V4_RE = UUID_V4_RE;
  BlindfoldSession.newSessionId = newSessionId;
  BlindfoldSession.newGameId = newGameId;
  BlindfoldSession.isUuidV4 = isUuidV4;
  BlindfoldSession.isSessionCategory = isSessionCategory;
  BlindfoldSession.normalizeProtocolVersion = normalizeProtocolVersion;
  BlindfoldSession.createSessionMetadata = createSessionMetadata;
  BlindfoldSession.addGameToSession = addGameToSession;
  // Exported for task 2.6 (session_store.js save/restore validation).
  // Additive only: no behavior change to this module.
  BlindfoldSession.requireValidMetadata = requireValidMetadata;
})();

// Node test shim. Content-script and importScripts() consumers use the
// BlindfoldSession global directly; only environments that provide CommonJS
// get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
