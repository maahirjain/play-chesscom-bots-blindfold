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
    assert.deepStrictEqual(
      Object.keys(manifest).sort(),
      ['background', 'content_scripts', 'manifest_version', 'name', 'version',
       'web_accessible_resources'].sort()
    );
  });

  it('no permissions, host_permissions, content_security_policy; version unchanged', () => {
    assert.ok(!('permissions' in manifest));
    assert.ok(!('host_permissions' in manifest));
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

// --- AC3: sw.js is a comment-only registration stub: no functional code.
describe('AC3 — sw.js contains no functional code', () => {
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

  it('stripped of comments, the stub is exactly the use-strict directive', () => {
    const lines = codeOnly.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    assert.deepStrictEqual(lines, ["'use strict';"]);
  });

  const forbidden = [
    'indexedDB',
    'onMessage',
    'onConnect',
    'onStartup',
    'onInstalled',
    'chrome.storage',
    'importScripts',
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

  it('content_scripts + web_accessible_resources blocks byte-identical (AC6)', () => {
    assert.strictEqual(
      manifestRaw.slice(newContentIdx),
      oldRaw.slice(oldContentIdx),
      'content_scripts/web_accessible_resources blocks changed'
    );
  });

  it('the only manifest change is the inserted background block (AC4)', () => {
    // Note: oldRaw.slice(0, oldContentIdx) already ends with the 4-space
    // indent of the "content_scripts" line, so the inserted block carries
    // no leading spaces of its own.
    const expectedBg = '"background": {\n        "service_worker": "sw.js"\n    },\n    ';
    assert.strictEqual(
      manifestRaw.slice(0, newContentIdx),
      oldRaw.slice(0, oldContentIdx) + expectedBg,
      'manifest head changed beyond the background block'
    );
  });

  it('sw.js is new (not present at HEAD)', () => {
    assert.throws(
      () => execSync('git show HEAD:sw.js', { cwd: REPO, stdio: 'pipe' }),
      'sw.js unexpectedly present at HEAD'
    );
  });
});
