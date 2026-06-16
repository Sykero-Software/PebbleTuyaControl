# Tuya Lights UX Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add list quick-toggle (short SELECT toggles a light, long SELECT opens controls), optional auto-close after a confirmed toggle, and persisted light state that is usable immediately on launch.

**Architecture:** The watch persists the light list per-light (256-byte key cap) and restores it at `init()` so the list is togglable before PKJS responds. PKJS queues commands that arrive before its device slots are loaded and replays them after `loadAll()`. Auto-close waits for an explicit `CmdDone` confirmation from PKJS (PebbleKit JS dies on app exit, so the cloud call must finish first) with a ~4 s timeout fallback. Two new Clay toggles configure the behaviour and are sent to the watch as message keys.

**Tech Stack:** Pebble SDK 3 (C watchapp), PebbleKit JS (`src/pkjs`, CommonJS), Clay config, Jest for PKJS pure-logic unit tests.

---

## File structure

- `src/pkjs/tuya-lights.js` — **pure logic** (already the testable module). Add `cfgToInts()` and `commandDeliverable()`.
- `tests/tuya-lights.test.js` — add unit tests for the two new pure functions.
- `src/pkjs/index.js` — PKJS wiring: command queue/replay, send config to watch. (Not Jest-testable — uses `Pebble`/`XMLHttpRequest`/`localStorage`; covered by the extracted pure helpers + manual verification.)
- `src/pkjs/config.js` — Clay config: add the two toggles.
- `package.json` — append the three message keys.
- `src/c/tuya.h` — shared declarations for config flags + `begin_auto_close`.
- `src/c/pebble-tuya.c` — persistence, config receive, list quick-toggle, auto-close machinery, `CmdDone` handling.
- `src/c/control-window.c` — trigger auto-close on the control-window toggle.

## Known limitation (documented, accepted for v1)

Commands are addressed by **list index**, not device identity. If the device set or
online/offline ordering changes between the cached launch and the fresh `loadAll()`,
a queued toggle could land on a different light. The common case (same devices, same
order) is correct. Keying by device id is out of scope for this plan.

---

## Task 1: PKJS pure helpers — config derivation + command deliverability

**Files:**
- Modify: `src/pkjs/tuya-lights.js` (add two functions + exports)
- Test: `tests/tuya-lights.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tuya-lights.test.js`:

```js
describe('cfgToInts', () => {
  test('defaults: quick-toggle on, auto-close off when keys absent', () => {
    expect(L.cfgToInts({})).toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0 });
    expect(L.cfgToInts(undefined)).toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0 });
  });
  test('maps booleans to ints', () => {
    expect(L.cfgToInts({ CfgQuickToggle: false, CfgAutoClose: true }))
      .toEqual({ CfgQuickToggle: 0, CfgAutoClose: 1 });
    expect(L.cfgToInts({ CfgQuickToggle: true, CfgAutoClose: false }))
      .toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0 });
  });
});

describe('commandDeliverable', () => {
  const slots = [{ index: 0, id: 'A' }];
  test('false when slot missing', () => {
    expect(L.commandDeliverable(0, [], {}, {})).toBe(false);
  });
  test('false when caps or state missing', () => {
    expect(L.commandDeliverable(0, slots, {}, { A: { on: 0 } })).toBe(false);
    expect(L.commandDeliverable(0, slots, { A: { switchCode: 's' } }, {})).toBe(false);
  });
  test('true when slot, caps and state are present', () => {
    expect(L.commandDeliverable(0, slots, { A: { switchCode: 's' } }, { A: { on: 0 } })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd PebbleTuyaControl && npx jest tuya-lights -t 'cfgToInts'`
Expected: FAIL — `L.cfgToInts is not a function`.

- [ ] **Step 3: Implement the two functions**

In `src/pkjs/tuya-lights.js`, add before `module.exports`:

```js
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
```

Update the `module.exports` object to include them:

```js
module.exports = {
  ACTIONS: ACTIONS, detectCaps: detectCaps, rawToPercent: rawToPercent, percentToRaw: percentToRaw,
  parseStatus: parseStatus, actionToCommands: actionToCommands,
  applyActionToState: applyActionToState, mapDevicesToSlots: mapDevicesToSlots,
  cfgToInts: cfgToInts, commandDeliverable: commandDeliverable
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd PebbleTuyaControl && npx jest tuya-lights`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
cd PebbleTuyaControl
git add src/pkjs/tuya-lights.js tests/tuya-lights.test.js
git commit -m "feat(pkjs): add cfgToInts + commandDeliverable pure helpers"
```

---

## Task 2: PKJS wiring — command queue/replay + send config to watch

**Files:**
- Modify: `src/pkjs/index.js`

No unit test (module loads Pebble/browser globals). The decision kernels are covered by Task 1; behaviour is verified on the emulator/real watch in Task 9.

- [ ] **Step 1: Add the pending-command queue and helpers**

In `src/pkjs/index.js`, just below the in-memory model declarations (`var stateById = {};`), add:

```js
var _pendingCmds = [];      // commands received before slots/caps were ready

function drainPending() {
  if (!_pendingCmds.length) return;
  var pend = _pendingCmds;
  _pendingCmds = [];
  pend.forEach(function (c) { handleCommand(c.idx, c.action); });
}

function sendConfig() {
  var c = L.cfgToInts(readSettings());
  sendMsg({ CfgQuickToggle: c.CfgQuickToggle, CfgAutoClose: c.CfgAutoClose });
}
```

- [ ] **Step 2: Replace `handleCommand` to queue undeliverable commands and stamp `CmdDone`**

Replace the entire existing `handleCommand` function with:

```js
function handleCommand(idx, action) {
  if (action === L.ACTIONS.REFRESH) { loadAll(); return; }
  if (!L.commandDeliverable(idx, slots, capsById, stateById)) {
    _pendingCmds.push({ idx: idx, action: action });   // replayed after loadAll()
    return;
  }
  var slot = slots[idx];
  var caps = capsById[slot.id];
  var state = stateById[slot.id];
  var cmds = L.actionToCommands(action, state, caps);
  if (!cmds.length) return;
  var c = getClient();
  if (!c) { sendMsg({ Ready: 0 }); return; }
  c.request('POST', '/v1.0/iot-03/devices/' + slot.id + '/commands', { commands: cmds })
    .then(function () {
      // Trust the ACKed command — do NOT re-read /status (the cloud lags the device).
      stateById[slot.id] = L.applyActionToState(action, state, caps);
      var msg = rowMsg(slot, stateById[slot.id]);
      msg.CmdDone = slot.index;   // confirmation signal for the watch's auto-close
      sendMsg(msg);
    })
    .catch(function (e) {
      // Command failed — revert the watch's optimistic update to the last known state.
      if (stateById[slot.id]) sendMsg(rowMsg(slot, stateById[slot.id]));
      sendError(e.message || 'Command failed');
    });
}
```

- [ ] **Step 3: Drain the queue after `loadAll()` finishes**

In `loadAll`, in the final `.then` callback, add `drainPending();` after `pushRows();`:

```js
    return chain.then(function () {
      slots = L.mapDevicesToSlots(devices, capsById);
      pushRows();
      drainPending();
    });
```

- [ ] **Step 4: Send config on ready and on config-close**

Replace the `ready` listener:

```js
Pebble.addEventListener('ready', function () { sendConfig(); loadAll(); startPolling(); });
```

In the `webviewclosed` listener, add `sendConfig();` after `clay.getSettings(...)`:

```js
Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) { return; }
  clay.getSettings(e.response); // persists flattened values to localStorage 'clay-settings'
  sendConfig();                  // push the (possibly changed) control toggles to the watch
  loadAll();                     // refresh with the new credentials
  startPolling();                // apply any change to the auto-refresh interval
});
```

- [ ] **Step 5: Run the PKJS test suite (regression check)**

Run: `cd PebbleTuyaControl && npx jest`
Expected: PASS (no test imports index.js; this just confirms nothing else broke).

- [ ] **Step 6: Commit**

```bash
cd PebbleTuyaControl
git add src/pkjs/index.js
git commit -m "feat(pkjs): queue/replay commands before load; send control config + CmdDone"
```

---

## Task 3: Append the three message keys + clean rebuild

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Append the keys (only at the end — IDs are positional)**

In `package.json`, change the `messageKeys` array to:

```json
    "messageKeys": [
      "ListCount", "RowIndex", "RowName", "RowOn", "RowBright", "RowTemp",
      "CmdLightIndex", "CmdAction", "ErrorMsg", "Ready", "RowOnline",
      "CfgQuickToggle", "CfgAutoClose", "CmdDone"
    ],
```

- [ ] **Step 2: Clean rebuild so the `MESSAGE_KEY_*` C macros regenerate**

A plain `pebble build` caches `build/js/message_keys.json` + the C header, so the new
macros would be missing. Run a clean build:

Run: `cd PebbleTuyaControl && PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble clean && PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build`
Expected: build succeeds (the C side does not yet reference the new macros, so it compiles; this just verifies the keys parse and regenerate).

- [ ] **Step 3: Commit**

```bash
cd PebbleTuyaControl
git add package.json
git commit -m "feat: append CfgQuickToggle/CfgAutoClose/CmdDone message keys"
```

---

## Task 4: Shared declarations in `tuya.h`

**Files:**
- Modify: `src/c/tuya.h`

- [ ] **Step 1: Add the config-flag externs and `begin_auto_close` declaration**

In `src/c/tuya.h`, after the existing `extern int s_light_count;` line, add:

```c
// Control settings — defined in pebble-tuya.c, set from the phone (CfgQuickToggle/
// CfgAutoClose) and persisted. control-window.c reads s_cfg_auto_close.
extern bool s_cfg_quick_toggle;
extern bool s_cfg_auto_close;
```

And under the `// pebble-tuya.c` comment, alongside `void send_command(...)`, add:

```c
void begin_auto_close(int index);   // show "Switching…", close once CmdDone/timeout
```

- [ ] **Step 2: Commit (compiles after Task 5; commit together with Task 5)**

No build here — `s_cfg_*` are defined in Task 5. This header edit is committed at the end of Task 5.

---

## Task 5: Persistence + config flags in `pebble-tuya.c`

**Files:**
- Modify: `src/c/pebble-tuya.c`

- [ ] **Step 1: Add persist keys and config-flag definitions**

In `src/c/pebble-tuya.c`, after the `enum { ST_LOADING ... }` / `static int s_state` block, add:

```c
// Persist keys. Each Light is 48 bytes (< the 256-byte per-key cap), but 12 of them
// (576 bytes) do NOT fit one key — so store one key per light + a count key.
#define PERSIST_KEY_COUNT        100
#define PERSIST_KEY_QUICK_TOGGLE 101
#define PERSIST_KEY_AUTO_CLOSE   102
#define PERSIST_KEY_LIGHT_BASE   200   // + i

bool s_cfg_quick_toggle = true;    // default ON  (matches Clay defaultValue)
bool s_cfg_auto_close   = false;   // default OFF (matches Clay defaultValue)
```

- [ ] **Step 2: Add `load_persisted()` and `save_persisted()`**

Add these functions above `init()`:

```c
static void load_persisted(void) {
  if (persist_exists(PERSIST_KEY_QUICK_TOGGLE)) s_cfg_quick_toggle = persist_read_bool(PERSIST_KEY_QUICK_TOGGLE);
  if (persist_exists(PERSIST_KEY_AUTO_CLOSE))   s_cfg_auto_close   = persist_read_bool(PERSIST_KEY_AUTO_CLOSE);
  if (!persist_exists(PERSIST_KEY_COUNT)) return;
  int n = persist_read_int(PERSIST_KEY_COUNT);
  if (n > MAX_LIGHTS) n = MAX_LIGHTS;
  int valid = 0;
  for (int i = 0; i < n; i++) {
    if (persist_exists(PERSIST_KEY_LIGHT_BASE + i) &&
        persist_get_size(PERSIST_KEY_LIGHT_BASE + i) == (int)sizeof(Light)) {
      persist_read_data(PERSIST_KEY_LIGHT_BASE + i, &s_lights[i], sizeof(Light));
      valid++;
    } else break;
  }
  s_light_count = valid;
  if (valid > 0) s_state = ST_READY;   // cached list is usable immediately
}

static void save_persisted(void) {
  persist_write_bool(PERSIST_KEY_QUICK_TOGGLE, s_cfg_quick_toggle);
  persist_write_bool(PERSIST_KEY_AUTO_CLOSE, s_cfg_auto_close);
  persist_write_int(PERSIST_KEY_COUNT, s_light_count);
  for (int i = 0; i < s_light_count && i < MAX_LIGHTS; i++) {
    persist_write_data(PERSIST_KEY_LIGHT_BASE + i, &s_lights[i], sizeof(Light));
  }
}
```

- [ ] **Step 3: Call them in `init()` / `deinit()`**

In `init()`, add `load_persisted();` as the FIRST line (before `app_message_open`/window push):

```c
static void init(void) {
  load_persisted();
  app_message_register_inbox_received(inbox_received);
  ...
```

In `deinit()`, add `save_persisted();` as the FIRST line:

```c
static void deinit(void) {
  save_persisted();
  control_window_deinit();
  window_destroy(s_list_window);
}
```

- [ ] **Step 4: Build to verify it compiles** (also picks up the Task 4 header)

Run: `cd PebbleTuyaControl && PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build`
Expected: build succeeds.

- [ ] **Step 5: Commit (header + source together)**

```bash
cd PebbleTuyaControl
git add src/c/tuya.h src/c/pebble-tuya.c
git commit -m "feat(watch): persist light list + control flags; restore at launch"
```

---

## Task 6: Receive config from the phone + persist on receipt

**Files:**
- Modify: `src/c/pebble-tuya.c` (`inbox_received`)

- [ ] **Step 1: Read the config keys in `inbox_received`**

In `inbox_received`, after the `Ready` handling block and before the `ListCount` block, add:

```c
  Tuple *qt = dict_find(it, MESSAGE_KEY_CfgQuickToggle);
  if (qt) { s_cfg_quick_toggle = qt->value->int32 ? true : false; persist_write_bool(PERSIST_KEY_QUICK_TOGGLE, s_cfg_quick_toggle); }
  Tuple *ac = dict_find(it, MESSAGE_KEY_CfgAutoClose);
  if (ac) { s_cfg_auto_close = ac->value->int32 ? true : false; persist_write_bool(PERSIST_KEY_AUTO_CLOSE, s_cfg_auto_close); }
```

(Persisted immediately so the setting survives even if the app is killed before `deinit()`.)

- [ ] **Step 2: Build to verify it compiles**

Run: `cd PebbleTuyaControl && PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd PebbleTuyaControl
git add src/c/pebble-tuya.c
git commit -m "feat(watch): apply + persist control config from phone"
```

---

## Task 7: Auto-close machinery in `pebble-tuya.c`

**Files:**
- Modify: `src/c/pebble-tuya.c`

- [ ] **Step 1: Add the closing window, timer, state and helpers**

Near the top of `pebble-tuya.c` (after the `static StatusBarLayer *s_status;` line), add the state and a forward declaration:

```c
// --- Auto-close (close the app once a toggle's cloud command is confirmed) ---
static int s_close_pending_index = -1;     // -1 = no close pending
static AppTimer *s_close_timer = NULL;
static Window *s_closing_window = NULL;
static TextLayer *s_closing_text = NULL;
static void do_close(void);
static void cancel_auto_close(void);
```

Then add these functions above `init()` (after `save_persisted`):

```c
static void closing_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  GRect b = layer_get_bounds(root);
  s_closing_text = text_layer_create(GRect(4, (b.size.h - 30) / 2, b.size.w - 8, 30));
  text_layer_set_font(s_closing_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_closing_text, GTextAlignmentCenter);
  text_layer_set_text(s_closing_text, "Switching…");
  layer_add_child(root, text_layer_get_layer(s_closing_text));
}
static void closing_unload(Window *w) { text_layer_destroy(s_closing_text); s_closing_text = NULL; }

static void close_timeout(void *ctx) { s_close_timer = NULL; do_close(); }

void begin_auto_close(int index) {
  s_close_pending_index = index;
  if (!s_closing_window) {
    s_closing_window = window_create();
    window_set_window_handlers(s_closing_window, (WindowHandlers){ .load = closing_load, .unload = closing_unload });
  }
  window_stack_push(s_closing_window, true);
  s_close_timer = app_timer_register(4000, close_timeout, NULL);   // fallback so it never hangs
}

static void cancel_auto_close(void) {
  if (s_close_pending_index < 0) return;
  s_close_pending_index = -1;
  if (s_close_timer) { app_timer_cancel(s_close_timer); s_close_timer = NULL; }
  if (s_closing_window && window_stack_get_top_window() == s_closing_window)
    window_stack_remove(s_closing_window, true);
}

static void do_close(void) {
  if (s_close_timer) { app_timer_cancel(s_close_timer); s_close_timer = NULL; }
  s_close_pending_index = -1;
  window_stack_pop_all(true);   // exits the app -> deinit() persists state
}
```

- [ ] **Step 2: Handle `CmdDone` and cancel-on-error in `inbox_received`**

In `inbox_received`, in the `ErrorMsg` branch, add `cancel_auto_close();` as the first line (a failed command must not auto-close):

```c
  if ((t = dict_find(it, MESSAGE_KEY_ErrorMsg))) {
    cancel_auto_close();
    strncpy(s_error, t->value->cstring, sizeof(s_error) - 1);
    s_error[sizeof(s_error) - 1] = '\0';
    list_window_reload(); return;
  }
```

At the very END of `inbox_received` (after `if (idx_t) control_window_refresh(...)`), add the confirmation check:

```c
  Tuple *cd = dict_find(it, MESSAGE_KEY_CmdDone);
  if (cd && s_close_pending_index >= 0 && cd->value->int32 == s_close_pending_index) {
    do_close();
  }
```

- [ ] **Step 3: Clean up the closing window + timer in `deinit()`**

Update `deinit()`:

```c
static void deinit(void) {
  save_persisted();
  if (s_close_timer) app_timer_cancel(s_close_timer);
  control_window_deinit();
  if (s_closing_window) window_destroy(s_closing_window);
  window_destroy(s_list_window);
}
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd PebbleTuyaControl && PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
cd PebbleTuyaControl
git add src/c/pebble-tuya.c
git commit -m "feat(watch): auto-close on confirmed toggle (Switching… modal + timeout)"
```

---

## Task 8: List quick-toggle + long-press in `pebble-tuya.c`

**Files:**
- Modify: `src/c/pebble-tuya.c` (`menu_select`, add `menu_select_long`, callbacks)

- [ ] **Step 1: Replace `menu_select` and add `menu_select_long`**

Replace the existing `menu_select` function with:

```c
static void menu_select(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  if (!s_cfg_quick_toggle) { control_window_push(ci->row); return; }   // classic behaviour
  int row = ci->row;
  if (row >= s_light_count) return;
  s_lights[row].on = !s_lights[row].on;   // optimistic; PKJS pushes authoritative state back
  send_command(row, ACT_TOGGLE);
  menu_layer_reload_data(s_menu);
  if (s_cfg_auto_close) begin_auto_close(row);
}

static void menu_select_long(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  control_window_push(ci->row);   // long press always opens the control window
}
```

- [ ] **Step 2: Register the long-click callback**

In `list_load`, add `.select_long_click = menu_select_long` to the `MenuLayerCallbacks`:

```c
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks){
    .get_num_rows = menu_num_rows, .draw_row = menu_draw_row,
    .select_click = menu_select, .select_long_click = menu_select_long });
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd PebbleTuyaControl && PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd PebbleTuyaControl
git add src/c/pebble-tuya.c
git commit -m "feat(watch): list quick-toggle (short SELECT) + long-press opens controls"
```

---

## Task 9: Auto-close on control-window toggle

**Files:**
- Modify: `src/c/control-window.c` (`select_click`)

- [ ] **Step 1: Trigger auto-close after the control-window toggle**

Replace `select_click` in `src/c/control-window.c` with:

```c
static void select_click(ClickRecognizerRef r, void *ctx) {
  if (s_index >= s_light_count) return;
  s_lights[s_index].on = !s_lights[s_index].on;
  send_command(s_index, ACT_TOGGLE);
  render();
  if (s_cfg_auto_close) begin_auto_close(s_index);   // declared in tuya.h
}
```

(`s_cfg_auto_close` and `begin_auto_close` come from `tuya.h`, already included at the top of the file.)

- [ ] **Step 2: Build to verify it compiles**

Run: `cd PebbleTuyaControl && PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd PebbleTuyaControl
git add src/c/control-window.c
git commit -m "feat(watch): auto-close after control-window toggle"
```

---

## Task 10: Clay config — two control toggles

**Files:**
- Modify: `src/pkjs/config.js`

- [ ] **Step 1: Add the "Controls" section**

In `src/pkjs/config.js`, insert this section object immediately before the final
`{ "type": "submit", "defaultValue": "Save" }` element:

```js
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Controls" },
      { "type": "toggle", "messageKey": "CfgQuickToggle",
        "label": "Tap in list toggles the light (hold to open controls)",
        "defaultValue": true },
      { "type": "toggle", "messageKey": "CfgAutoClose",
        "label": "Close the app after toggling",
        "defaultValue": false }
    ]
  },
```

- [ ] **Step 2: Run the PKJS test suite (regression)**

Run: `cd PebbleTuyaControl && npx jest`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd PebbleTuyaControl
git add src/pkjs/config.js
git commit -m "feat(config): add quick-toggle + auto-close control toggles"
```

---

## Task 11: Emulator verification (screenshots) + surface to user

**Files:**
- Temporary, REVERTED after: `src/c/pebble-tuya.c` (seed cached state for screenshots)

- [ ] **Step 1: Temporarily seed a cached list so the emulator (no phone) can render it**

In `load_persisted()`, temporarily add this at the very end (the emulator has no
persisted data and no phone, so seed an in-memory list):

```c
  // TEMP for emulator screenshots — REVERT before committing.
  if (s_light_count == 0) {
    strncpy(s_lights[0].name, "Kitchen", NAME_LEN - 1); s_lights[0].on = 1; s_lights[0].bright = 80; s_lights[0].temp = 50; s_lights[0].online = 1;
    strncpy(s_lights[1].name, "Bedroom", NAME_LEN - 1); s_lights[1].on = 0; s_lights[1].bright = 0;  s_lights[1].temp = -1; s_lights[1].online = 1;
    s_light_count = 2; s_state = ST_READY;
  }
```

- [ ] **Step 2: Boot the emulator and capture the list**

Run:
```bash
scripts/pebble-emu-boot.sh diorite
cd PebbleTuyaControl
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble install --emulator diorite
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble screenshot --no-open /tmp/tuya-list-diorite.png
```
Then repeat the boot/build/install/screenshot on **emery** (the user's real board is a Pebble Time 2) into `/tmp/tuya-list-emery.png`.
Expected: a list showing "Kitchen — On · 80%" and "Bedroom — Off".

- [ ] **Step 3: Capture the "Switching…" modal**

Temporarily add `begin_auto_close(0);` as the last line of `list_load` (so the modal
shows on launch), rebuild/install/screenshot into `/tmp/tuya-switching-emery.png`,
then remove that line. (On the emulator no phone confirms, so the ~4 s timeout will
then close the app — that also verifies the timeout-close path.)

- [ ] **Step 4: Surface every screenshot to the user**

Use `SendUserFile` for `/tmp/tuya-list-diorite.png`, `/tmp/tuya-list-emery.png`, and
`/tmp/tuya-switching-emery.png` (per CLAUDE.md: always surface screenshots).

- [ ] **Step 5: REVERT the temporary seeds and confirm a clean build**

Remove the TEMP block from `load_persisted()` and the temporary `begin_auto_close(0);`
line. Verify:

Run: `cd PebbleTuyaControl && git diff --stat src/c/pebble-tuya.c`
Expected: no remaining diff from the temporary seeds (only the real Task 5–8 changes,
already committed).

Run: `cd PebbleTuyaControl && PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build`
Expected: build succeeds.

- [ ] **Step 6: Bump the superrepo gitlink**

```bash
cd /home/dev/pebble-timetracking
git add PebbleTuyaControl
git commit -m "Bump PebbleTuyaControl: list quick-toggle, auto-close, persisted state"
```

---

## Task 12: Real-watch verification (manual, Core Devices / Pebble Time 2)

PebbleKit JS dies on app exit and the emulator cannot deliver phone AppMessages, so
the cloud-confirmed close and the toggle-before-load path must be checked on hardware.

- [ ] **Step 1: Install on the watch**

Run: `cd PebbleTuyaControl && pebble install --cloudpebble build/*.pbw`
(See CLAUDE.md for the one-time `pebble login` flow.)

- [ ] **Step 2: Verify, in a separate `pebble logs --cloudpebble` session, each behaviour:**
  - Short SELECT on a list row toggles that light (watch optimistic + cloud follows).
  - Long SELECT opens the control window.
  - Toggling `CfgQuickToggle` off in config restores "SELECT opens controls".
  - With `CfgAutoClose` on: a toggle shows "Switching…" and the app closes shortly
    after the light actually changes; on a failed command it stays open with the error.
  - Re-launching the app shows the last light list immediately and a toggle issued
    before fresh data loads still takes effect once data arrives.

- [ ] **Step 3: Report results to the user** (and capture a watch screenshot if useful).

---

## Self-review notes (completed)

- **Spec coverage:** Feature 1 → Tasks 8, 10; Feature 2 → Tasks 7, 9, 10 (+ `CmdDone` in 2/3); Feature 3 → Tasks 2, 5; shared infra (keys/persistence/queue) → Tasks 2, 3, 5; config → Task 10; tests → Task 1; verification → Tasks 11, 12.
- **Type/name consistency:** `s_cfg_quick_toggle`/`s_cfg_auto_close`, `begin_auto_close`, `do_close`, `cancel_auto_close`, `commandDeliverable`, `cfgToInts`, `CmdDone`, persist key macros — used identically across tasks.
- **No placeholders:** every code step shows full code; the only TODO-style text is the explicitly-temporary screenshot seed in Task 11, which Step 5 reverts.
