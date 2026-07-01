var Clay = require('pebble-clay');
var clayConfig = require('./config');
// autoHandleEvents:false — our config keys (TuyaAccessId/Secret/Region) are Clay-only
// (not in messageKeys), so we must NOT let Clay auto-send them to the watch. We persist
// them via clay.getSettings() (writes localStorage 'clay-settings') and reload ourselves.
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var selComp = require('./config_selection_list');
clay.registerComponent(selComp.catalogStore);
clay.registerComponent(selComp.selectionList);

var client = require('./tuya-client');
var L = require('./tuya-lights');
var S = require('./tuya-scenes');

var REGION_HOST = {
  eu: 'https://openapi.tuyaeu.com', us: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuyacn.com', in: 'https://openapi.tuyain.com'
};

// In-memory model for this session.
var slots = [];            // [{index, id, name}]
var capsById = {};         // id -> caps
var stateById = {};        // id -> {on,bright,temp}
var _pendingCmds = [];      // commands received before slots/caps were ready
var scenes = [];               // [{id,name,home_id}] from the last scene fetch
var catalog = { v: 1, items: [] };   // all selectable entries, baked into the config page

function drainPending() {
  if (!_pendingCmds.length) return;
  var pend = _pendingCmds;
  _pendingCmds = [];
  pend.forEach(function (c) { handleCommand(c.id, c.action, c.desiredOn); });
}

function sendConfig() {
  var c = L.cfgToInts(readSettings());
  sendMsg({ CfgQuickToggle: c.CfgQuickToggle, CfgAutoClose: c.CfgAutoClose, CfgMru: c.CfgMru, CfgIdleExitSec: c.CfgIdleExitSec });
}

function readSettings() {
  try { return JSON.parse(localStorage.getItem('clay-settings')) || {}; } catch (e) { return {}; }
}

function getCfg() {
  var s = readSettings();
  var id = s.TuyaAccessId, secret = s.TuyaAccessSecret, region = s.TuyaRegion || 'eu';
  if (!id || !secret) return null;
  return { clientId: id, secret: secret, host: REGION_HOST[region] || REGION_HOST.eu };
}

function getPollMs() {
  var n = parseInt(readSettings().TuyaPollInterval, 10);
  return (n > 0) ? n * 1000 : 0;
}

// Reuse one Tuya client so its cached access-token is shared across the device load
// AND every later command — rebuild only when the configured credentials change.
var _client = null, _clientKey = null;
function getClient() {
  var cfg = getCfg();
  if (!cfg) return null;
  var key = cfg.clientId + '|' + cfg.host;
  if (!_client || _clientKey !== key) { _client = client.createClient(cfg, http, deps); _clientKey = key; }
  return _client;
}

// XMLHttpRequest-based HTTP that returns the parsed Tuya envelope.
function http(opts) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open(opts.method, opts.url, true);
    var h = opts.headers || {};
    Object.keys(h).forEach(function (k) { xhr.setRequestHeader(k, h[k]); });
    xhr.onload = function () {
      try { resolve(JSON.parse(xhr.responseText)); }
      catch (e) { reject(new Error('Bad JSON from Tuya')); }
    };
    xhr.onerror = function () { reject(new Error('Network error')); };
    xhr.send(opts.body || null);
  });
}

// Persist the Tuya token (keyed by client id) so a relaunch reuses a still-valid
// token instead of re-fetching one before it can issue a command.
var TOKEN_CACHE_KEY = 'tuya-token';
var deps = {
  now: function () { return Date.now(); },
  nonce: function () {
    return 'xxxxxxxx'.replace(/x/g, function () { return Math.floor(Math.random() * 16).toString(16); });
  },
  loadToken: function (clientId) {
    try { var o = JSON.parse(localStorage.getItem(TOKEN_CACHE_KEY)); return (o && o.clientId === clientId) ? o : null; }
    catch (e) { return null; }
  },
  saveToken: function (clientId, v) {
    try { localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ clientId: clientId, token: v.token, expiresAt: v.expiresAt })); }
    catch (e) {}
  }
};

// Cache the device model (slots + caps + state) across launches so a command is
// deliverable from cache immediately on startup — without it, the cold-start loadAll
// chain (token + devices + per-device spec + status) ran long enough that, under
// auto-close, the app exited before a queued command reached the cloud.
var MODEL_CACHE_KEY = 'tuya-model';
function saveModel() {
  try { localStorage.setItem(MODEL_CACHE_KEY, L.packModel(slots, capsById, stateById)); } catch (e) {}
}
function loadModel() {
  var m = null;
  try { m = L.unpackModel(localStorage.getItem(MODEL_CACHE_KEY)); } catch (e) { m = null; }
  if (!m) return false;
  slots = m.slots; capsById = m.capsById; stateById = m.stateById;
  return true;
}
function clearModel() {
  slots = []; capsById = {}; stateById = {};
  try { localStorage.removeItem(MODEL_CACHE_KEY); } catch (e) {}
}

// Persist the catalog (device+scene names + scene home_ids) so a scene tapped right
// after a cold start is triggerable from cache (home_id known) without a full refetch,
// and so the config page can show it on first open.
var CATALOG_CACHE_KEY = 'tuya-catalog';
function saveCatalog() { try { localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(catalog)); } catch (e) {} }
function loadCatalog() {
  try { var o = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY)); if (o && o.items) catalog = o; } catch (e) {}
}
function sceneHomeId(id) {
  for (var i = 0; i < catalog.items.length; i++) {
    var it = catalog.items[i];
    if (it.kind === 'S' && it.id === id) return it.home_id;
  }
  return null;
}

// Pebble has a SINGLE outbox: a second sendAppMessage before the first is ACKed is
// dropped (APP_MSG_BUSY). Serialize all outbound messages through an ack-gated queue
// so multi-row list pushes arrive reliably.
var _outQ = [];
var _sending = false;
function sendMsg(data) { _outQ.push(data); pump(); }
function pump() {
  if (_sending || !_outQ.length) return;
  _sending = true;
  var data = _outQ.shift();
  Pebble.sendAppMessage(data,
    function () { _sending = false; pump(); },
    function () { _sending = false; pump(); });
}

function sendError(msg) {
  sendMsg({ ErrorMsg: msg });
}

function rowMsg(slot, st) {
  return {
    RowIndex: slot.index, RowId: slot.id, RowName: slot.name,
    RowOn: st.on, RowBright: st.bright, RowTemp: st.temp,
    RowOnline: slot.online, RowKind: (slot.kind === 'S') ? 1 : 0
  };
}

function pushRows() {
  sendMsg({ ListCount: slots.length, Ready: 1 });
  slots.forEach(function (s) {
    sendMsg(rowMsg(s, stateById[s.id] || { on: 0, bright: 0, temp: -1 }));
  });
}

// Fetch tap-to-run scenes for every home the linked account owns. Best-effort: any
// failure (e.g. the "Smart Home Scene Linkage" API not subscribed) resolves to [] so
// the device list still works.
function fetchScenes(c, devices) {
  var uid = S.extractUid(devices);
  if (!uid) return Promise.resolve([]);
  return c.request('GET', '/v1.0/users/' + uid + '/homes').then(function (resp) {
    var homes = (resp.result) || [];
    var all = [];
    var chain = Promise.resolve();
    homes.forEach(function (h) {
      chain = chain.then(function () {
        return c.request('GET', '/v1.1/homes/' + h.home_id + '/scenes').then(function (sr) {
          var raw = (sr.result && sr.result.list) || sr.result || [];   // tolerate array or {list:[]}
          all = all.concat(S.filterScenes(raw, h.home_id));
        });
      });
    });
    return chain.then(function () { return all; });
  }).catch(function () { return []; });
}

function loadAll() {
  var c = getClient();
  if (!c) { sendMsg({ Ready: 0 }); return; }
  sendMsg({ Syncing: 1 });

  var devices = [];
  c.request('GET', '/v1.0/iot-01/associated-users/devices').then(function (resp) {
    devices = (resp.result && resp.result.devices) || [];
    // Specification (capability codes/ranges; cached, never changes) + live status,
    // per device, sequentially (small N).
    var chain = Promise.resolve();
    devices.forEach(function (d) {
      chain = chain.then(function () {
        var capsP = capsById[d.id]
          ? Promise.resolve(capsById[d.id])
          : c.request('GET', '/v1.0/iot-03/devices/' + d.id + '/specification').then(function (spec) {
              capsById[d.id] = L.detectCaps(spec.result); return capsById[d.id];
            });
        return capsP.then(function (caps) {
          return c.request('GET', '/v1.0/iot-03/devices/' + d.id + '/status').then(function (stat) {
            stateById[d.id] = L.parseStatus(stat.result || [], caps);
          });
        });
      });
    });
    return chain;
  }).then(function () {
    return fetchScenes(c, devices);
  }).then(function (fetched) {
    scenes = fetched;
    catalog = S.buildCatalog(devices, capsById, scenes);
    saveCatalog();
    // The user's ordered selection is the single source of truth for the list.
    slots = S.resolveSelection(readSettings().TuyaSelection, devices, capsById, scenes, 12);
    saveModel();
    pushRows();
    drainPending();
    sendMsg({ Syncing: 0 });
  }).catch(function (e) { sendMsg({ Syncing: 0 }); sendError(e.message || 'Tuya error'); });
}

function handleCommand(id, action, desiredOn) {
  if (action === L.ACTIONS.REFRESH) { loadAll(); return; }
  if (action === L.ACTIONS.SCENE_RUN) { triggerScene(id); return; }
  if (!L.commandDeliverable(id, slots, capsById, stateById)) {
    _pendingCmds.push({ id: id, action: action, desiredOn: desiredOn });   // replayed after loadAll()
    return;
  }
  var slot = L.resolveSlot(id, slots);   // by stable device id, never by list position
  var caps = capsById[slot.id];
  var state = stateById[slot.id];
  var cmds = L.actionToCommands(action, state, caps, desiredOn);
  if (!cmds.length) return;
  var c = getClient();
  if (!c) { sendMsg({ Ready: 0 }); return; }
  c.request('POST', '/v1.0/iot-03/devices/' + slot.id + '/commands', { commands: cmds })
    .then(function () {
      // Trust the ACKed command — do NOT re-read /status (the cloud lags the device).
      stateById[slot.id] = L.applyActionToState(action, state, caps, desiredOn);
      saveModel();   // persist the confirmed state so a relaunch starts from truth
      var msg = rowMsg(slot, stateById[slot.id]);
      msg.CmdDone = slot.id;   // confirmation signal for the watch's auto-close (by id)
      sendMsg(msg);
    })
    .catch(function (e) {
      // Command failed — revert the watch's optimistic update to the last known state.
      if (stateById[slot.id]) sendMsg(rowMsg(slot, stateById[slot.id]));
      sendError(e.message || 'Command failed');
    });
}

// Resolve a scene's home_id from the cached catalog; if absent (a scene added since
// the last load), refetch devices+scenes once, rebuild the catalog, and try again.
function ensureSceneHome(c, id) {
  var home = sceneHomeId(id);
  if (home) return Promise.resolve(home);
  var devices = [];
  return c.request('GET', '/v1.0/iot-01/associated-users/devices').then(function (resp) {
    devices = (resp.result && resp.result.devices) || [];
    return fetchScenes(c, devices);
  }).then(function (fetched) {
    scenes = fetched;
    catalog = S.buildCatalog(devices, capsById, scenes);
    saveCatalog();
    return sceneHomeId(id);
  });
}

function triggerScene(id) {
  var c = getClient();
  if (!c) { sendMsg({ Ready: 0 }); return; }
  ensureSceneHome(c, id).then(function (home) {
    if (!home) { sendError('Scene not found'); return; }
    return c.request('POST', '/v1.0/homes/' + home + '/scenes/' + id + '/trigger', null).then(function () {
      sendMsg({ CmdDone: id });   // success — confirms the watch's scene-run modal (by id)
    });
  }).catch(function (e) { sendError(e.message || 'Scene failed'); });
}

// Auto-refresh timer (only while the app is open — PKJS runs foreground-only).
var _pollTimer = null;
function startPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  var ms = getPollMs();
  if (ms > 0) _pollTimer = setInterval(loadAll, ms);
}

Pebble.addEventListener('ready', function () {
  sendConfig();
  loadCatalog();   // scene home_ids available immediately for a launch-time scene tap
  // Restore the cached model first so a command pressed during the cold-start
  // refresh is deliverable immediately (POSTed now) instead of queued until loadAll.
  if (loadModel()) pushRows();
  loadAll();
  startPolling();
});

Pebble.addEventListener('showConfiguration', function () {
  refreshCatalogThen(function () {
    seedConfigData();
    Pebble.openURL(clay.generateUrl());
  });
});

// Refresh the catalog (device + scene names) before opening config so the picker is
// current. Best-effort: on any failure (or no creds) open with whatever catalog we have.
function refreshCatalogThen(cb) {
  var c = getClient();
  if (!c) { cb(); return; }
  var devices = [];
  c.request('GET', '/v1.0/iot-01/associated-users/devices').then(function (resp) {
    devices = (resp.result && resp.result.devices) || [];
    var chain = Promise.resolve();
    devices.forEach(function (d) {
      chain = chain.then(function () {
        return capsById[d.id] ? Promise.resolve()
          : c.request('GET', '/v1.0/iot-03/devices/' + d.id + '/specification').then(function (spec) {
              capsById[d.id] = L.detectCaps(spec.result);
            });
      });
    });
    return chain;
  }).then(function () { return fetchScenes(c, devices); })
    .then(function (fetched) { scenes = fetched; catalog = S.buildCatalog(devices, capsById, scenes); saveCatalog(); cb(); })
    .catch(function () { cb(); });
}

// Bake the catalog + a default (empty) selection into clay-settings so the config
// page's custom components can read them (the config webview has no localStorage).
function seedConfigData() {
  var s = readSettings();
  s.TuyaCatalog = JSON.stringify(catalog);
  if (s.TuyaSelection === undefined) s.TuyaSelection = [];
  try { localStorage.setItem('clay-settings', JSON.stringify(s)); } catch (e) {}
}

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) { return; }
  clay.getSettings(e.response); // persists flattened values to localStorage 'clay-settings'
  sendConfig();                  // push the (possibly changed) control toggles to the watch
  clearModel();                  // credentials may have changed account -> drop stale cache
  loadAll();                     // refresh with the new credentials
  startPolling();                // apply any change to the auto-refresh interval
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload;
  if (p.CmdAction !== undefined && p.CmdLightId !== undefined) {
    handleCommand(p.CmdLightId, p.CmdAction, p.CmdDesiredOn);
  }
});
