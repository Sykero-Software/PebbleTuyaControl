var Clay = require('pebble-clay');
var clayConfig = require('./config');
// autoHandleEvents:false — our config keys (TuyaAccessId/Secret/Region) are Clay-only
// (not in messageKeys), so we must NOT let Clay auto-send them to the watch. We persist
// them via clay.getSettings() (writes localStorage 'clay-settings') and reload ourselves.
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var client = require('./tuya-client');
var L = require('./tuya-lights');

var REGION_HOST = {
  eu: 'https://openapi.tuyaeu.com', us: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuyacn.com', in: 'https://openapi.tuyain.com'
};

// In-memory model for this session.
var slots = [];            // [{index, id, name}]
var capsById = {};         // id -> caps
var stateById = {};        // id -> {on,bright,temp}

function getCfg() {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('clay-settings')) || {}; } catch (e) { s = {}; }
  var id = s.TuyaAccessId, secret = s.TuyaAccessSecret, region = s.TuyaRegion || 'eu';
  if (!id || !secret) return null;
  return { clientId: id, secret: secret, host: REGION_HOST[region] || REGION_HOST.eu };
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

var deps = {
  now: function () { return Date.now(); },
  nonce: function () {
    return 'xxxxxxxx'.replace(/x/g, function () { return Math.floor(Math.random() * 16).toString(16); });
  }
};

function sendError(msg) {
  Pebble.sendAppMessage({ ErrorMsg: msg });
}

function pushRows() {
  Pebble.sendAppMessage({ ListCount: slots.length, Ready: 1 });
  slots.forEach(function (s) {
    var st = stateById[s.id] || { on: 0, bright: 0, temp: -1 };
    Pebble.sendAppMessage({
      RowIndex: s.index, RowName: s.name, RowOn: st.on, RowBright: st.bright, RowTemp: st.temp
    });
  });
}

function loadAll() {
  var cfg = getCfg();
  if (!cfg) { Pebble.sendAppMessage({ Ready: 0 }); return; }
  var c = client.createClient(cfg, http, deps);

  c.request('GET', '/v1.0/iot-01/associated-users/devices').then(function (resp) {
    var devices = (resp.result && resp.result.devices) || [];
    // Fetch specification + status for each device sequentially (small N).
    var chain = Promise.resolve();
    devices.forEach(function (d) {
      chain = chain.then(function () {
        return c.request('GET', '/v1.0/iot-03/devices/' + d.id + '/specification').then(function (spec) {
          capsById[d.id] = L.detectCaps(spec.result);
          return c.request('GET', '/v1.0/iot-03/devices/' + d.id + '/status').then(function (stat) {
            stateById[d.id] = L.parseStatus(stat.result || [], capsById[d.id]);
          });
        });
      });
    });
    return chain.then(function () {
      slots = L.mapDevicesToSlots(devices, capsById);
      pushRows();
    });
  }).catch(function (e) { sendError(e.message || 'Tuya error'); });
}

function handleCommand(idx, action) {
  var slot = slots[idx];
  if (!slot) return;
  if (action === L.ACTIONS.REFRESH) { loadAll(); return; }
  var caps = capsById[slot.id];
  var state = stateById[slot.id];
  var cmds = L.actionToCommands(action, state, caps);
  if (!cmds.length) return;
  var cfg = getCfg();
  var c = client.createClient(cfg, http, deps);
  c.request('POST', '/v1.0/iot-03/devices/' + slot.id + '/commands', { commands: cmds })
    .then(function () {
      return c.request('GET', '/v1.0/iot-03/devices/' + slot.id + '/status').then(function (stat) {
        stateById[slot.id] = L.parseStatus(stat.result || [], caps);
        var st = stateById[slot.id];
        Pebble.sendAppMessage({ RowIndex: idx, RowName: slot.name, RowOn: st.on, RowBright: st.bright, RowTemp: st.temp });
      });
    })
    .catch(function (e) { sendError(e.message || 'Command failed'); });
}

Pebble.addEventListener('ready', function () { loadAll(); });

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) { return; }
  clay.getSettings(e.response); // persists flattened values to localStorage 'clay-settings'
  loadAll();                     // refresh with the new credentials
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload;
  if (p.CmdAction !== undefined && p.CmdLightIndex !== undefined) {
    handleCommand(p.CmdLightIndex, p.CmdAction);
  }
});
