// tests/capture_broker.test.js
//
// V1 verification for the 4.3 SW-side capture broker (capture_broker.js)
// per .autodev/evidence/4.3.contract.md §2. The broker owns every chrome.*
// call the offscreen capture selector needs; the SW never touches a
// MediaStream. DOM-free: the chrome namespace is injected (4.1 precedent).
//
// Run: node --test tests/capture_broker.test.js   (from repo root)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BS = require(path.join(REPO, 'capture_broker.js'));

// Scriptable chrome mock. opts:
//   tabs: array of tab objects returned by tabs.query
//   noTabs / noPermissions / noTabCapture: remove the namespace
//   containsResult: boolean returned by permissions.contains
function mockChrome(opts) {
  const o = opts || {};
  const state = { queryUrls: [], streamIdCalls: 0, targetTabIds: [] };
  const chrome = { state };
  if (!o.noTabs) {
    chrome.tabs = {
      query: async (q) => {
        state.queryUrls.push(q.url);
        return (o.tabs || []).map((t) => Object.assign({}, t));
      }
    };
  }
  if (!o.noPermissions) {
    chrome.permissions = {
      contains: async () => o.containsResult === undefined ? true : o.containsResult
    };
  }
  if (!o.noTabCapture) {
    chrome.tabCapture = {
      getMediaStreamId: async (opts2) => {
        state.streamIdCalls++;
        state.targetTabIds.push(opts2.targetTabId);
        if (o.streamIdError) {
          throw o.streamIdError;
        }
        return ('streamId' in o) ? o.streamId : 'mock-stream-id';
      }
    };
  }
  return chrome;
}

describe('AC1 — broker module', () => {
  it('loads via the shim and exposes the factory', () => {
    assert.equal(typeof BS.createCaptureBroker, 'function');
    assert.equal(BS.GAME_TAB_URL_PATTERN, 'https://www.chess.com/play/computer*');
  });

  it('constructs with an injected chrome namespace', () => {
    const broker = BS.createCaptureBroker(mockChrome({}));
    for (const m of ['resolveTargetTab', 'queryCapturePermission', 'getStreamId']) {
      assert.equal(typeof broker[m], 'function');
    }
  });
});

describe('resolveTargetTab', () => {
  it('returns the most-recently-active game tab (lastAccessed)', async () => {
    const broker = BS.createCaptureBroker(mockChrome({
      tabs: [
        { id: 1, title: 'Old', lastAccessed: 100 },
        { id: 2, title: 'New', lastAccessed: 200 },
        { id: 3, title: 'Other', url: 'https://example.com/' }
      ]
    }));
    const res = await broker.resolveTargetTab();
    assert.deepEqual(res, { ok: true, tabId: 2, tabTitle: 'New' });
  });

  it('prefers the active tab when lastAccessed is unavailable', async () => {
    const broker = BS.createCaptureBroker(mockChrome({
      tabs: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Active', active: true }
      ]
    }));
    const res = await broker.resolveTargetTab();
    assert.equal(res.tabId, 2);
  });

  it('no matching tab → honest no-target-tab, never the active tab', async () => {
    const broker = BS.createCaptureBroker(mockChrome({ tabs: [] }));
    const res = await broker.resolveTargetTab();
    assert.deepEqual(res,
      { ok: true, tabId: null, tabTitle: null, reason: 'no-target-tab' });
  });

  it('queries with the game-tab URL pattern', async () => {
    const chrome = mockChrome({ tabs: [] });
    const broker = BS.createCaptureBroker(chrome);
    await broker.resolveTargetTab();
    assert.deepEqual(chrome.state.queryUrls,
      ['https://www.chess.com/play/computer*']);
  });

  it('a tab without a numeric id is not a target', async () => {
    const broker = BS.createCaptureBroker(mockChrome({
      tabs: [{ title: 'No id' }]
    }));
    const res = await broker.resolveTargetTab();
    assert.equal(res.tabId, null);
  });

  it('absent chrome.tabs → plain Error (unavailable capability)', async () => {
    const broker = BS.createCaptureBroker(mockChrome({ noTabs: true }));
    await assert.rejects(() => broker.resolveTargetTab(), /chrome.tabs.query is unavailable/);
  });
});

describe('queryCapturePermission', () => {
  it('granted when the permission is present', async () => {
    const broker = BS.createCaptureBroker(mockChrome({ containsResult: true }));
    const res = await broker.queryCapturePermission();
    assert.deepEqual(res, { ok: true, permissionState: 'granted' });
  });

  it('denied when the user revoked it', async () => {
    const broker = BS.createCaptureBroker(mockChrome({ containsResult: false }));
    const res = await broker.queryCapturePermission();
    assert.deepEqual(res, { ok: true, permissionState: 'denied' });
  });

  it('absent chrome.permissions → unknown, never fabricated', async () => {
    const broker = BS.createCaptureBroker(mockChrome({ noPermissions: true }));
    const res = await broker.queryCapturePermission();
    assert.deepEqual(res, { ok: true, permissionState: 'unknown' });
  });
});

describe('getStreamId', () => {
  it('mints a streamId for the target tab; the SW never sees media', async () => {
    const chrome = mockChrome({});
    const broker = BS.createCaptureBroker(chrome);
    const res = await broker.getStreamId(42);
    assert.deepEqual(res, { ok: true, streamId: 'mock-stream-id' });
    assert.deepEqual(chrome.state.targetTabIds, [42]);
    assert.equal(chrome.state.streamIdCalls, 1);
  });

  it('rejects a bad tabId with TypeError', async () => {
    const broker = BS.createCaptureBroker(mockChrome({}));
    await assert.rejects(() => broker.getStreamId('42'), TypeError);
    await assert.rejects(() => broker.getStreamId(-1), TypeError);
  });

  it('absent chrome.tabCapture → plain Error (unavailable capability)', async () => {
    const broker = BS.createCaptureBroker(mockChrome({ noTabCapture: true }));
    await assert.rejects(() => broker.getStreamId(42),
      /chrome.tabCapture.getMediaStreamId is unavailable/);
  });

  it('an empty streamId is an error, not a silent empty string', async () => {
    const broker = BS.createCaptureBroker(mockChrome({ streamId: '' }));
    await assert.rejects(() => broker.getStreamId(42), /returned no streamId/);
  });
});
