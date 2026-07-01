// Clay custom components for the Tuya device/scene picker. Serialized via toSource()
// and re-eval'd in the config webview, so EVERYTHING is self-contained: no module-scope
// helpers referenced from a manipulator/initialize, no spread/destructuring, no imports.

// Holds the catalog JSON (device+scene names) baked into clay-settings by PKJS; renders
// nothing. selectionList reads it via clayConfig.getItemByMessageKey('TuyaCatalog').
var catalogStore = {
  name: 'catalogStore',
  template: '<div style="display:none"></div>',
  manipulator: {
    get: function () { return this._v === undefined ? '' : this._v; },
    set: function (value) {
      var v = value;
      if (v && typeof v === 'object' && v.value !== undefined) { v = v.value; }
      this._v = v;
      return this;
    }
  },
  defaults: {}
};

// Reorderable list of device/scene rows. Value = ordered array of "L:<id>"/"S:<id>".
var selectionList = {
  name: 'selectionList',
  template:
    '<div class="sl-root">' +
    '<div class="sl-list"></div>' +
    '<button type="button" class="sl-add">+ Add</button>' +
    '</div>',
  style:
    '.sl-row{display:flex;align-items:center;margin:0 0 8px 0}' +
    '.sl-row .sl-sel{flex:1 1 auto;min-width:0;height:2.8rem;margin:0;background-color:#767676;color:#fff;border:none;border-radius:0.3rem;padding:0 0.5rem;color-scheme:dark}' +
    '.sl-row button{flex:0 0 auto;min-width:0;width:2.8rem;height:2.8rem;margin:0 0 0 6px;padding:0}' +
    '.sl-row button[disabled]{opacity:.35}' +
    '.sl-add{min-width:0;margin:8px 0 10px 0}',
  manipulator: {
    get: function () { return this._slGetValue ? this._slGetValue() : []; },
    set: function (value) {
      var arr = [];
      var v = value;
      if (v && typeof v === 'object' && !Array.isArray(v) && v.value !== undefined) { v = v.value; }
      if (Array.isArray(v)) { arr = v; }
      else if (typeof v === 'string' && v !== '') {
        try { var p = JSON.parse(v); if (Array.isArray(p)) { arr = p; } } catch (e) { arr = []; }
      }
      if (this._slRebuild) { this._slRebuild(arr); }
      return this;
    }
  },
  defaults: { label: '' },
  initialize: function (minified, clayConfig) {
    var self = this;
    var root = self.$element[0];
    var MAX = 12;
    var catalogItems = [];

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function nameFor(kind, id) {
      for (var i = 0; i < catalogItems.length; i++) {
        if (catalogItems[i].kind === kind && catalogItems[i].id === id) { return catalogItems[i].name; }
      }
      return null;
    }
    function label(kind, name) { return (kind === 'S' ? '▶ ' : '💡 ') + name; }
    function optionsHtml(selKind, selId) {
      var html = '', found = false, i;
      for (i = 0; i < catalogItems.length; i++) {
        var it = catalogItems[i];
        var isSel = (it.kind === selKind && it.id === selId);
        if (isSel) { found = true; }
        html += '<option value="' + esc(it.kind + ':' + it.id) + '"' + (isSel ? ' selected' : '') + '>' + esc(label(it.kind, it.name)) + '</option>';
      }
      // Keep the current selection selectable even if the catalog no longer lists it
      // (device/scene removed, or catalog not yet loaded) so its value survives re-render.
      if (!found && selId) {
        html = '<option value="' + esc(selKind + ':' + selId) + '" selected>' + esc(label(selKind, selId) + ' (unavailable)') + '</option>' + html;
      }
      return html;
    }
    function rowHtml(kind, id) {
      return '<div class="sl-row">' +
        '<select class="sl-sel">' + optionsHtml(kind, id) + '</select>' +
        '<button type="button" class="sl-up">&#9650;</button>' +
        '<button type="button" class="sl-down">&#9660;</button>' +
        '<button type="button" class="sl-del">&#10005;</button>' +
        '</div>';
    }
    function readTokens() {
      var rows = root.querySelectorAll('.sl-row'), out = [], i;
      for (i = 0; i < rows.length; i++) {
        var sel = rows[i].querySelector('.sl-sel');
        if (sel && sel.value) { out.push(sel.value); }
      }
      return out;
    }
    function updateButtons() {
      var rows = root.querySelectorAll('.sl-row'), i;
      for (i = 0; i < rows.length; i++) {
        var up = rows[i].querySelector('.sl-up'), dn = rows[i].querySelector('.sl-down');
        if (up) { up.disabled = (i === 0); }
        if (dn) { dn.disabled = (i === rows.length - 1); }
      }
      var add = root.querySelector('.sl-add');
      if (add) { add.style.display = (catalogItems.length === 0 || rows.length >= MAX) ? 'none' : ''; }
    }
    function renderTokens(tokens) {
      var list = root.querySelector('.sl-list'), html = '', i;
      for (i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        html += rowHtml(t.charAt(0), t.slice(2));
      }
      list.innerHTML = html;
      updateButtons();
    }
    function firstToken() {
      if (catalogItems.length) { return catalogItems[0].kind + ':' + catalogItems[0].id; }
      return '';
    }

    self._slGetValue = function () { return readTokens(); };
    self._slRebuild = function (tokens) { renderTokens(tokens || []); };

    root.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.className || typeof t.className !== 'string') { return; }
      if (t.className.indexOf('sl-add') >= 0) {
        var toks = readTokens();
        var f = firstToken();
        if (toks.length < MAX && f) { toks.push(f); renderTokens(toks); self.trigger('change'); }
        return;
      }
      var row = t;
      while (row && row !== root && !(row.className && String(row.className).indexOf('sl-row') >= 0)) { row = row.parentNode; }
      if (!row || row === root) { return; }
      var rows = root.querySelectorAll('.sl-row'), idx = -1, i;
      for (i = 0; i < rows.length; i++) { if (rows[i] === row) { idx = i; break; } }
      if (idx < 0) { return; }
      var arr = readTokens();
      if (t.className.indexOf('sl-del') >= 0) { arr.splice(idx, 1); }
      else if (t.className.indexOf('sl-up') >= 0 && idx > 0) { var a = arr[idx - 1]; arr[idx - 1] = arr[idx]; arr[idx] = a; }
      else if (t.className.indexOf('sl-down') >= 0 && idx < arr.length - 1) { var b = arr[idx + 1]; arr[idx + 1] = arr[idx]; arr[idx] = b; }
      else { return; }
      renderTokens(arr);
      self.trigger('change');
    });
    root.addEventListener('change', function (e) {
      if (e.target && e.target.className && String(e.target.className).indexOf('sl-sel') >= 0) { self.trigger('change'); }
    });

    // The catalog item's DOM exists only after the whole page is built, so read it at
    // AFTER_BUILD and re-render with real labels (the initial set() ran with no catalog).
    clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
      var store = clayConfig.getItemByMessageKey('TuyaCatalog');
      if (store) {
        var raw = store.get();
        var parsed = null;
        try { parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { parsed = null; }
        if (parsed && parsed.items) { catalogItems = parsed.items; }
      }
      renderTokens(readTokens());
    });
  }
};

module.exports = { catalogStore: catalogStore, selectionList: selectionList };
