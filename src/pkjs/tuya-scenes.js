// Pure helpers for Tuya scene support + the config device/scene selection list.
// Kept side-effect-free so they unit-test in isolation (the PKJS glue is in index.js).

// The associated-users/devices result carries a `uid` per device; scenes are scoped
// to that user's homes. Read it from the device list (the grant_type=1 token's uid is
// empty for this linked-account model).
function extractUid(devices) {
  var ds = devices || [];
  for (var i = 0; i < ds.length; i++) {
    if (ds[i] && ds[i].uid) return ds[i].uid;
  }
  return null;
}

// Keep only executable tap-to-run scenes (enabled && status '1'), tagging each with the
// home_id needed to trigger it.
function filterScenes(rawScenes, homeId) {
  var out = [];
  var rs = rawScenes || [];
  for (var i = 0; i < rs.length; i++) {
    var s = rs[i];
    if (s && s.enabled === true && s.status === '1') {
      out.push({ id: s.scene_id, name: s.name, home_id: homeId });
    }
  }
  return out;
}

// The catalog is the full set of selectable entries the config page offers.
function buildCatalog(devices, capsById, scenes) {
  var items = [];
  var ds = devices || [], caps = capsById || {}, sc = scenes || [];
  for (var i = 0; i < ds.length; i++) {
    var d = ds[i];
    var c = caps[d.id];
    if (c && c.switchCode) items.push({ kind: 'L', id: d.id, name: d.name });
  }
  for (var j = 0; j < sc.length; j++) {
    items.push({ kind: 'S', id: sc[j].id, name: sc[j].name, home_id: sc[j].home_id });
  }
  return { v: 1, items: items };
}

// Selection tokens are "L:<deviceId>" / "S:<sceneId>". Split on the FIRST ':' only
// (ids never start with a bare kind+':' but may themselves contain other chars).
function parseToken(tok) {
  if (typeof tok !== 'string' || tok.length < 3 || tok.charAt(1) !== ':') return null;
  var kind = tok.charAt(0);
  if (kind !== 'L' && kind !== 'S') return null;
  return { kind: kind, id: tok.slice(2) };
}
function makeToken(kind, id) { return kind + ':' + id; }

// Resolve an ordered selection into ordered watch rows. Config order is authoritative
// (NO online-first sort — that is the watch's opt-in CfgMru behaviour). Tokens whose
// device/scene no longer exists are dropped; result is capped at `max`.
function resolveSelection(selection, devices, capsById, scenes, max) {
  var m = (max && max > 0) ? max : 12;
  var devById = {}, i;
  var ds = devices || [], caps = capsById || {}, sc = scenes || [];
  for (i = 0; i < ds.length; i++) devById[ds[i].id] = ds[i];
  var sceneById = {};
  for (i = 0; i < sc.length; i++) sceneById[sc[i].id] = sc[i];
  var slots = [];
  var sel = Array.isArray(selection) ? selection : [];
  for (i = 0; i < sel.length && slots.length < m; i++) {
    var t = parseToken(sel[i]);
    if (!t) continue;
    if (t.kind === 'L') {
      var d = devById[t.id], c = caps[t.id];
      if (d && c && c.switchCode) slots.push({ index: 0, id: d.id, name: d.name, online: d.online ? 1 : 0, kind: 'L' });
    } else {
      var s = sceneById[t.id];
      if (s) slots.push({ index: 0, id: s.id, name: s.name, online: 1, kind: 'S' });
    }
  }
  for (i = 0; i < slots.length; i++) slots[i].index = i;
  return slots;
}

module.exports = {
  extractUid: extractUid, filterScenes: filterScenes, buildCatalog: buildCatalog,
  parseToken: parseToken, makeToken: makeToken, resolveSelection: resolveSelection
};
