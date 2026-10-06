// capture_broker.js
//
// Task 4.3 (PLAN.md §4.3): the service-worker side of the chrome.* split.
// Offscreen documents expose only chrome.runtime (4.2's empirical finding),
// so every chrome.* call the capture selector needs lives here:
//
//   - chrome.tabs.query ......... find the chess.com game tab
//   - chrome.permissions.contains  query the tabCapture permission state
//   - chrome.tabCapture.getMediaStreamId .. mint the probe's streamId
//
// The SW never touches a MediaStream: getMediaStreamId returns an opaque
// streamId string that the offscreen document consumes via getUserMedia
// with the chromeMediaSource constraints (capture_selection.js).
//
// Loaded by sw.js via importScripts(); recording_host.js routes the
// 'capture-resolve-tab' / 'capture-query-permission' /
// 'capture-get-stream-id' recorder-channel messages here. DOM-free: the
// chrome namespace is injected, so the whole module is unit-testable in
// Node with a mock.
//
// Manifest (4.3): "tabCapture" permission + host_permissions
// ["https://www.chess.com/*"]. The host permission lets tabs.query({url})
// return tab metadata (id, title) without the "tabs" permission.
//
// Error conventions (AGENTS.md): TypeError = wrong type/shape;
// RangeError = bad domain value; plain Error = unavailable platform
// capability (e.g. no chrome.tabCapture — never a weak fallback).

var BlindfoldSession = BlindfoldSession || {};

(function () {
  'use strict';

  // The game-tab URL pattern the mission records. Kept in one place so
  // the SW broker and any future §5/§7 surface agree on what "the game
  // tab" means.
  var GAME_TAB_URL_PATTERN = 'https://www.chess.com/play/computer*';

  var TABCAPTURE_PERMISSION = 'tabCapture';
  var GAME_ORIGINS = ['https://www.chess.com/*'];

  function createCaptureBroker(chromeNs) {
    var chrome = chromeNs || {};

    function tabsNs() {
      return chrome.tabs || null;
    }

    function permissionsNs() {
      return chrome.permissions || null;
    }

    function tabCaptureNs() {
      return chrome.tabCapture || null;
    }

    // Find the chess.com game tab. Most-recently-active match wins
    // (chrome.tabs.Tab.lastAccessed, Chrome 121+); on older Chrome the
    // active tab wins, then the first match. No match → honest
    // { tabId: null, reason: 'no-target-tab' } — never a silent fallback
    // to the active tab (that could record the wrong tab).
    function resolveTargetTab() {
      var tabs = tabsNs();
      if (!tabs || typeof tabs.query !== 'function') {
        return Promise.reject(
          new Error('capture_broker: chrome.tabs.query is unavailable'));
      }
      return Promise.resolve()
        .then(function () {
          return tabs.query({ url: GAME_TAB_URL_PATTERN });
        })
        .then(function (list) {
          var arr = Array.isArray(list) ? list : [];
          if (arr.length === 0) {
            return { ok: true, tabId: null, tabTitle: null,
                     reason: 'no-target-tab' };
          }
          var best = arr[0];
          var bestScore = tabRecencyScore(best);
          for (var i = 1; i < arr.length; i++) {
            var s = tabRecencyScore(arr[i]);
            if (s > bestScore) {
              best = arr[i];
              bestScore = s;
            }
          }
          var tabId = (best && typeof best.id === 'number') ? best.id : null;
          if (tabId === null) {
            return { ok: true, tabId: null, tabTitle: null,
                     reason: 'no-target-tab' };
          }
          return {
            ok: true,
            tabId: tabId,
            tabTitle: (best && typeof best.title === 'string') ? best.title : null
          };
        });
    }

    // Higher = more recent. lastAccessed is Chrome 121+; without it the
    // active tab outranks the rest and the first match is the fallback.
    function tabRecencyScore(tab) {
      if (tab && typeof tab.lastAccessed === 'number') {
        return tab.lastAccessed;
      }
      if (tab && tab.active === true) {
        return 1;
      }
      return 0;
    }

    // Query the install-time tabCapture permission. 'granted' means the
    // manifest permission is present and not revoked by the user;
    // 'denied' means revoked (denial is a state, not an exception — 4.2
    // precedent). Anything unparseable → 'unknown', never fabricated.
    function queryCapturePermission() {
      var perms = permissionsNs();
      if (!perms || typeof perms.contains !== 'function') {
        return Promise.resolve({ ok: true, permissionState: 'unknown' });
      }
      return Promise.resolve()
        .then(function () {
          return perms.contains({ permissions: [TABCAPTURE_PERMISSION],
                                  origins: GAME_ORIGINS });
        })
        .then(function (granted) {
          return { ok: true,
                   permissionState: granted === true ? 'granted' : 'denied' };
        }, function () {
          return { ok: true, permissionState: 'unknown' };
        });
    }

    // Mint the probe's streamId for the target tab. Returns the opaque
    // string the offscreen document feeds to getUserMedia; the SW never
    // sees media bytes. Absent chrome.tabCapture → plain Error
    // (unavailable platform capability).
    function getStreamId(tabId) {
      if (typeof tabId !== 'number' || tabId < 0) {
        return Promise.reject(new TypeError(
          'capture_broker.getStreamId: tabId must be a non-negative number'));
      }
      var tc = tabCaptureNs();
      if (!tc || typeof tc.getMediaStreamId !== 'function') {
        return Promise.reject(
          new Error('capture_broker: chrome.tabCapture.getMediaStreamId is unavailable'));
      }
      return Promise.resolve()
        .then(function () {
          return tc.getMediaStreamId({ targetTabId: tabId });
        })
        .then(function (streamId) {
          if (typeof streamId !== 'string' || streamId === '') {
            throw new Error('capture_broker: chrome.tabCapture returned no streamId');
          }
          return { ok: true, streamId: streamId };
        });
    }

    return {
      resolveTargetTab: resolveTargetTab,
      queryCapturePermission: queryCapturePermission,
      getStreamId: getStreamId
    };
  }

  BlindfoldSession.GAME_TAB_URL_PATTERN = GAME_TAB_URL_PATTERN;
  BlindfoldSession.createCaptureBroker = createCaptureBroker;
})();

// Node test shim. Loaded via importScripts() in the MV3 service worker;
// only environments that provide CommonJS get module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlindfoldSession;
}
