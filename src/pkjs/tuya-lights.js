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
    temp = (rt !== undefined) ? rawToPercent(rt, caps.tempMin, caps.tempMax) : 0;
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

function mapDevicesToSlots(devices, capsById) {
  var slots = [];
  for (var i = 0; i < devices.length && slots.length < 12; i++) {
    var d = devices[i];
    var c = capsById[d.id];
    if (c && c.switchCode) slots.push({ index: slots.length, id: d.id, name: d.name });
  }
  return slots;
}

module.exports = {
  ACTIONS: ACTIONS, detectCaps: detectCaps, rawToPercent: rawToPercent, percentToRaw: percentToRaw,
  parseStatus: parseStatus, actionToCommands: actionToCommands, mapDevicesToSlots: mapDevicesToSlots
};
