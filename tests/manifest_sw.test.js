// tests/manifest_sw.test.js
//
// V1 verification for task 2.1 (PLAN.md §2.1) per
// .autodev/evidence/2.1.contract.md. Covers acceptance criteria AC1–AC4
// (static) and AC6 (regression). AC5 (real Chrome load) runs separately via
// ~/workspace/tools/ext-verify/sw-load.js; AC7 (real device) is deferred to
// owner verification.
//
// Run: node --test tests/manifest_sw.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO, 'manifest.json');
const manifestRaw = fs.readFileSync(MANIFEST_PATH, 'utf8');
const manifest = JSON.parse(manifestRaw);

// --- AC1: manifest parses; MV3; background deep-equals {"service_worker": "sw.js"}.
describe('AC1 — manifest entry', () => {
  it('manifest.json parses as JSON', () => {
    assert.ok(typeof manifest === 'object' && manifest !== null);
  });

  it('manifest_version is 3', () => {
    assert.strictEqual(manifest.manifest_version, 3);
  });

  it('background is exactly { service_worker: "sw.js" } — no extra keys', () => {
    assert.deepStrictEqual(manifest.background, { service_worker: 'sw.js' });
    assert.strictEqual(Object.keys(manifest.background).length, 1);
  });

  it('no other top-level manifest keys were added', () => {
    // Honest cumulative evolution: 4.1 legitimately adds the "permissions"
    // key (exactly ["offscreen"]) per its contract, and 4.3 legitimately
    // adds "host_permissions" (exactly ["https://www.chess.com/*"]) per its
    // contract. The cumulative invariant: no other top-level keys beyond
    // the original six plus "permissions" plus "host_permissions".
    assert.deepStrictEqual(
      Object.keys(manifest).sort(),
      ['background', 'content_scripts', 'manifest_version', 'name', 'version',
       'web_accessible_resources', 'permissions', 'host_permissions'].sort()
    );
  });

  it('permissions is ["offscreen", "tabCapture"]; host_permissions is the game origin; version unchanged', () => {
    // Honest cumulative evolution: 4.1 adds the "offscreen" permission for
    // the dedicated recording context (PLAN.md §4.1); 4.3 adds
    // "tabCapture" plus host_permissions for the chess.com game tab
    // (PLAN.md §4.3). Nothing else.
    assert.deepStrictEqual(manifest.permissions, ['offscreen', 'tabCapture']);
    assert.deepStrictEqual(manifest.host_permissions, ['https://www.chess.com/*']);
    assert.ok(!('content_security_policy' in manifest));
    assert.strictEqual(manifest.version, '1.0.0');
  });
});

// --- AC2: sw.js exists at the extension root and is the file the manifest names.
describe('AC2 — sw.js exists', () => {
  it('the file named by the manifest entry exists at the extension root', () => {
    const swPath = path.join(REPO, manifest.background.service_worker);
    assert.strictEqual(swPath, path.join(REPO, 'sw.js'));
    assert.ok(fs.existsSync(swPath), 'sw.js missing at extension root');
  });
});

// --- AC3: sw.js functional code (as amended by task 2.2).
// 2.1 pinned a comment-only stub; 2.2 legitimately added one line,
// importScripts('db.js'), per its contract. The cumulative invariant: no
// other functional code (no listeners, storage, or fetch).
describe('AC3 — sw.js functional code is exactly the db.js import', () => {
  // Strip //-line and /* */-block comments so the header's own mentions of
  // intentionally-absent APIs do not count as functional code.
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => {
        const idx = line.indexOf('//');
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join('\n');
  }

  const swRaw = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
  const codeOnly = stripComments(swRaw);

  it('stripped of comments, functional code is the 4.3 wiring (cumulative)', () => {
    // 2.1 pinned the comment-only stub; 2.2 added the db.js import; 2.4
    // legitimately added the writer intake per its contract; 2.6
    // legitimately added the session-state storage primitives per its
    // contract; 2.7 legitimately added the lifecycle detector per its
    // contract; 4.1 legitimately adds the recording-context supervisor
    // (recording_host.js) plus its two startup lines per its contract;
    // 4.3 legitimately adds the SW-side capture broker (capture_broker.js)
    // per its contract (the chrome.* split: the offscreen document cannot
    // call chrome.tabCapture). Cumulative invariant: exactly these five
    // functional lines.
    const lines = codeOnly.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    assert.deepStrictEqual(lines, [
      "'use strict';",
      "importScripts('db.js', 'event_envelope.js', 'writer.js', 'session_identity.js', 'session_conditions.js', 'session_store.js', 'lifecycle.js', 'capture_broker.js', 'recording_host.js');",
      'BlindfoldSession.writerListener = BlindfoldSession.installWriterListener();',
      'BlindfoldSession.recordingHost = BlindfoldSession.createRecordingHost(globalThis.chrome || {});',
      'BlindfoldSession.recordingHost.start();'
    ]);
  });

  it('exactly one importScripts call, importing the 4.3 module set', () => {
    const calls = codeOnly.match(/importScripts\s*\(/g) || [];
    assert.strictEqual(calls.length, 1, 'expected exactly one importScripts call');
    assert.ok(codeOnly.includes("importScripts('db.js', 'event_envelope.js', 'writer.js', 'session_identity.js', 'session_conditions.js', 'session_store.js', 'lifecycle.js', 'capture_broker.js', 'recording_host.js')"),
      'must import the storage layer, the event contract, the writer, the session-state modules, the lifecycle detector, the SW capture broker, and the recording-context supervisor');
  });

  const forbidden = [
    'indexedDB',
    'onMessage',
    'onConnect',
    'onStartup',
    'onInstalled',
    'chrome.storage',
  ];
  for (const token of forbidden) {
    it(`no "${token}" outside comments`, () => {
      assert.ok(!codeOnly.includes(token), `found "${token}" in functional code`);
    });
  }
  it('no fetch() call outside comments', () => {
    assert.ok(!/\bfetch\s*\(/.test(codeOnly), 'found fetch() in functional code');
  });
});

// --- AC4/AC6: the task diff touches exactly manifest.json (background block
// only) and sw.js (new); content_scripts and web_accessible_resources blocks
// are byte-identical to HEAD.
describe('AC4/AC6 — diff is exactly the background block', () => {
  const oldRaw = execSync('git show HEAD:manifest.json', { cwd: REPO }).toString();
  const oldContentIdx = oldRaw.indexOf('"content_scripts"');
  const newContentIdx = manifestRaw.indexOf('"content_scripts"');

  it('pre-change manifest readable from git HEAD', () => {
    assert.notStrictEqual(oldContentIdx, -1);
    assert.notStrictEqual(newContentIdx, -1);
  });

  it('web_accessible_resources block byte-identical to HEAD (AC6, cumulative)', () => {
    // Honest cumulative evolution (4.4): HEAD now includes 4.3's pinned
    // host_permissions addition, so the 4.3-era archaeology (rebuilding
    // the tail from a pre-4.3 HEAD) no longer applies. 4.4's contract
    // requires NO manifest change; the durable assertion is that the
    // working-tree tail is byte-identical to HEAD's tail.
    const tailMarker = '"web_accessible_resources"';
    const newTail = manifestRaw.slice(manifestRaw.indexOf(tailMarker));
    const headTail = oldRaw.slice(oldRaw.indexOf(tailMarker));
    assert.strictEqual(newTail, headTail,
      'tail changed but 4.4 requires no manifest change');
  });

  it('manifest head is version/name/version/background/permissions (AC4, cumulative)', () => {
    // 2.1 inserted the background block; 2.2's contract requires the manifest
    // to be byte-identical to HEAD (pinned in tests/db.test.js); 4.1
    // legitimately inserts the "permissions": ["offscreen"] block after
    // background per its contract; 4.3 legitimately extends it to
    // ["offscreen", "tabCapture"] per its contract (host_permissions is
    // appended at the tail, pinned separately). The cumulative invariant:
    // the head is exactly these five keys, so no other permissions/CSP/
    // version changes can sneak in.
    const head = manifestRaw.slice(0, newContentIdx);
    assert.strictEqual(
      head,
      '{\n' +
      '    "manifest_version": 3,\n' +
      '    "name": "Play Chess.com Bots Blindfold",\n' +
      '    "version": "1.0.0",\n' +
      '    "background": {\n' +
      '        "service_worker": "sw.js"\n' +
      '    },\n' +
      '    "permissions": ["offscreen", "tabCapture"],\n' +
      '    ',
      'manifest head changed beyond the background + permissions blocks'
    );
  });

  // Superseded by task 2.2: sw.js is no longer new at HEAD (it was committed
  // by 2.1 and amended by 2.2). The cumulative sw.js state is pinned
  // git-independently in tests/db.test.js ("sw.js functional code is exactly
  // the importScripts line" + header-list checks).
  it('sw.js amendment state is owned by the 2.2 contract (see tests/db.test.js)', () => {
    assert.ok(fs.existsSync(path.join(REPO, 'sw.js')), 'sw.js missing');
  });
});
