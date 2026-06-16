var ACTIONS = { REFRESH: 0, TOGGLE: 1, BRIGHT_UP: 2, BRIGHT_DOWN: 3, TEMP_UP: 4, TEMP_DOWN: 5 };
var STEP = 20; // percent per button press

function parseRange(values, dMin, dMax) {
  try { var v = JSON.parse(values); return { min: v.min, max: v.max }; }
  catch (e) { return { min: dMin, max: dMax }; }
}

function findFn(fns, code) {
  for (var i = 0; i < fns.length; i++) if (fns[i].code === code) return fns[i];
  return null;
}

function detectCaps(spec) {
  var fns = (spec && spec.functions) || [];
  var caps = { switchCode: null, brightCode: null, brightMin: 0, brightMax: 100,
               tempCode: null, tempMin: 0, tempMax: 100 };
  if (findFn(fns, 'switch_led')) caps.switchCode = 'switch_led';
  else if (findFn(fns, 'switch')) caps.switchCode = 'switch';

  var b = findFn(fns, 'bright_value_v2') || findFn(fns, 'bright_value');
  if (b) { caps.brightCode = b.code; var r = parseRange(b.values, 10, 1000); caps.brightMin = r.min; caps.brightMax = r.max; }

  var tp = findFn(fns, 'temp_value_v2') || findFn(fns, 'temp_value');
  if (tp) { caps.tempCode = tp.code; var tr = parseRange(tp.values, 0, 1000); caps.tempMin = tr.min; caps.tempMax = tr.max; }
  return caps;
}

function rawToPercent(raw, min, max) {
  if (max === min) return 0;
  var p = Math.round(((raw - min) / (max - min)) * 100);
  return Math.max(0, Math.min(100, p));
}

function percentToRaw(pct, min, max) {
  var c = Math.max(0, Math.min(100, pct));
  return Math.round(min + (c / 100) * (max - min));
}

function statusValue(status, code) {
  for (var i = 0; i < status.length; i++) if (status[i].code === code) return status[i].value;
  return undefined;
}

function parseStatus(status, caps) {
  var on = caps.switchCode ? (statusValue(status, caps.switchCode) ? 1 : 0) : 0;
  var bright = 0;
  if (caps.brightCode) {
    var rb = statusValue(status, caps.brightCode);
    if (rb !== undefined) bright = rawToPercent(rb, caps.brightMin, caps.brightMax);
  }
  var temp = -1;
  if (caps.tempCode) {
    var rt = statusValue(status, caps.tempCode);
    // Keep -1 ('unsupported') when the declared temp code is absent from status,
    // so the watch does not show a bogus 0% control for an unreported value.
    temp = (rt !== undefined) ? rawToPercent(rt, caps.tempMin, caps.tempMax) : -1;
  }
  return { on: on, bright: bright, temp: temp };
}

function actionToCommands(action, state, caps) {
  if (action === ACTIONS.TOGGLE) {
    if (!caps.switchCode) return [];
    return [{ code: caps.switchCode, value: !state.on }];
  }
  if (action === ACTIONS.BRIGHT_UP || action === ACTIONS.BRIGHT_DOWN) {
    if (!caps.brightCode) return [];
    var nb = state.bright + (action === ACTIONS.BRIGHT_UP ? STEP : -STEP);
    return [{ code: caps.brightCode, value: percentToRaw(nb, caps.brightMin, caps.brightMax) }];
  }
  if (action === ACTIONS.TEMP_UP || action === ACTIONS.TEMP_DOWN) {
    if (!caps.tempCode) return [];
    var nt = state.temp + (action === ACTIONS.TEMP_UP ? STEP : -STEP);
    return [{ code: caps.tempCode, value: percentToRaw(nt, caps.tempMin, caps.tempMax) }];
  }
  return [];
}

function clampPct(v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

// Compute the new normalised state implied by a successful command, WITHOUT
// re-reading /status — the Tuya cloud lags the device's report, so an immediate
// re-fetch returns the pre-command value and would clobber the change. The real
// status is re-read on app open / REFRESH instead.
function applyActionToState(action, state, caps) {
  var ns = { on: state.on, bright: state.bright, temp: state.temp };
  if (action === ACTIONS.TOGGLE) ns.on = state.on ? 0 : 1;
  else if (action === ACTIONS.BRIGHT_UP) ns.bright = clampPct(state.bright + STEP);
  else if (action === ACTIONS.BRIGHT_DOWN) ns.bright = clampPct(state.bright - STEP);
  else if (action === ACTIONS.TEMP_UP && caps.tempCode) ns.temp = clampPct(state.temp + STEP);
  else if (action === ACTIONS.TEMP_DOWN && caps.tempCode) ns.temp = clampPct(state.temp - STEP);
  return ns;
}

function mapDevicesToSlots(devices, capsById) {
  var online = [], offline = [];
  for (var i = 0; i < devices.length; i++) {
    var d = devices[i];
    var c = capsById[d.id];
    if (!(c && c.switchCode)) continue;
    var slot = { index: 0, id: d.id, name: d.name, online: d.online ? 1 : 0 };
    (slot.online ? online : offline).push(slot);
  }
  // Online lights first, offline pushed to the bottom of the list; cap at 12.
  var all = online.concat(offline).slice(0, 12);
  for (var j = 0; j < all.length; j++) all[j].index = j;
  return all;
}

// Phone settings (Clay 'clay-settings', booleans/undefined) -> ints for the watch.
// Defaults when a key has never been saved: quick-toggle ON, auto-close OFF.
function cfgToInts(settings) {
  var s = settings || {};
  var qt = (s.CfgQuickToggle === undefined) ? 1 : (s.CfgQuickToggle ? 1 : 0);
  var ac = s.CfgAutoClose ? 1 : 0;
  return { CfgQuickToggle: qt, CfgAutoClose: ac };
}

// A command can run only once the device's slot, caps and status are all loaded.
// Before that the command must be queued (replayed after loadAll), not dropped.
function commandDeliverable(idx, slots, capsById, stateById) {
  var slot = slots[idx];
  if (!slot) return false;
  return !!(capsById[slot.id] && stateById[slot.id]);
}

module.exports = {
  ACTIONS: ACTIONS, detectCaps: detectCaps, rawToPercent: rawToPercent, percentToRaw: percentToRaw,
  parseStatus: parseStatus, actionToCommands: actionToCommands,
  applyActionToState: applyActionToState, mapDevicesToSlots: mapDevicesToSlots,
  cfgToInts: cfgToInts, commandDeliverable: commandDeliverable
};
