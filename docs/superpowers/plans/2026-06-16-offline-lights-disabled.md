# Offline lights are disabled — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tuya lights reported offline behave as disabled — greyed in the list, not togglable, and not openable into the control window; a press on one is a silent no-op.

**Architecture:** C-side UI only. The `Light.online` flag already arrives end-to-end (Tuya `d.online` → PKJS `RowOnline` → `s_lights[i].online`). Add `online` guards at the three interaction points (`menu_select`, `menu_select_long`, control-window `select_click`) and grey the offline row in `menu_draw_row`. No PKJS, message-key, persistence, or ordering changes.

**Tech Stack:** Pebble SDK (C), pebble-tool emulator (emery board for colour verification).

**Spec:** `docs/superpowers/specs/2026-06-16-offline-lights-disabled-design.md`

---

### Task 1: Block toggle/open for offline lights in the list

**Files:**
- Modify: `src/c/pebble-tuya.c` — `menu_select` (around line 120) and `menu_select_long` (around line 133)

- [ ] **Step 1: Guard `menu_select`**

In `menu_select`, after the existing `if (ci->row >= s_light_count) return;` line and before the classic-behaviour branch, resolve the light index once and bail if offline. Replace:

```c
static void menu_select(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  if (ci->row >= s_light_count) return;
  if (!s_cfg_quick_toggle) { control_window_push(s_order[ci->row]); return; }   // classic behaviour
  int row = s_order[ci->row];
```

with:

```c
static void menu_select(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  if (ci->row >= s_light_count) return;
  int row = s_order[ci->row];
  if (!s_lights[row].online) return;   // offline = disabled, silent no-op
  if (!s_cfg_quick_toggle) { control_window_push(row); return; }   // classic behaviour
```

(Note: the later `int row = s_order[ci->row];` line is now removed because `row` is declared up top; the remaining body — `s_lights[row].on = ...` onward — is unchanged.)

- [ ] **Step 2: Guard `menu_select_long`**

Replace:

```c
static void menu_select_long(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  if (ci->row >= s_light_count) return;
  control_window_push(s_order[ci->row]);   // long press always opens the control window
}
```

with:

```c
static void menu_select_long(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  if (ci->row >= s_light_count) return;
  int row = s_order[ci->row];
  if (!s_lights[row].online) return;   // offline = disabled, cannot open control window
  control_window_push(row);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/c/pebble-tuya.c
git commit -m "Tuya: offline lights cannot be toggled or opened from the list"
```

---

### Task 2: Defensive guard in the control window

**Files:**
- Modify: `src/c/control-window.c` — `select_click` (around line 45)

- [ ] **Step 1: Guard `select_click`**

Replace:

```c
static void select_click(ClickRecognizerRef r, void *ctx) {
  if (s_index >= s_light_count) return;
  s_lights[s_index].on = !s_lights[s_index].on;
```

with:

```c
static void select_click(ClickRecognizerRef r, void *ctx) {
  if (s_index >= s_light_count) return;
  if (!s_lights[s_index].online) return;   // offline = disabled, silent no-op
  s_lights[s_index].on = !s_lights[s_index].on;
```

- [ ] **Step 2: Commit**

```bash
git add src/c/control-window.c
git commit -m "Tuya: control window ignores SELECT toggle for offline lights"
```

---

### Task 3: Grey offline rows in the list

**Files:**
- Modify: `src/c/pebble-tuya.c` — `menu_draw_row` (around line 106)

- [ ] **Step 1: Set grey text colour for offline rows**

Replace the tail of `menu_draw_row`:

```c
  int li = (ci->row < s_light_count) ? s_order[ci->row] : ci->row;
  Light *l = &s_lights[li];
  static char sub[24];
  if (!l->online) snprintf(sub, sizeof(sub), "Offline");
  else if (l->on) snprintf(sub, sizeof(sub), "On · %d%%", l->bright);
  else snprintf(sub, sizeof(sub), "Off");
  menu_cell_basic_draw(g, cell, l->name, sub, NULL);
}
```

with:

```c
  int li = (ci->row < s_light_count) ? s_order[ci->row] : ci->row;
  Light *l = &s_lights[li];
  static char sub[24];
  if (!l->online) {
    snprintf(sub, sizeof(sub), "Offline");
    graphics_context_set_text_color(g, GColorLightGray);   // disabled look
  } else if (l->on) snprintf(sub, sizeof(sub), "On · %d%%", l->bright);
  else snprintf(sub, sizeof(sub), "Off");
  menu_cell_basic_draw(g, cell, l->name, sub, NULL);
}
```

The MenuLayer sets the per-row text colour before `draw_row`; overriding it to
`GColorLightGray` for offline rows greys both the title and subtitle. Online
rows are untouched. On 1-bit boards `GColorLightGray` degrades to black
(acceptable — colour boards are the target).

- [ ] **Step 2: Commit**

```bash
git add src/c/pebble-tuya.c
git commit -m "Tuya: grey out offline lights in the list"
```

---

### Task 4: Build + verify on the emery emulator

**Files:**
- Temporary (revert before finishing): `src/c/pebble-tuya.c` — `load_persisted` seed for screenshot

- [ ] **Step 1: Boot the emulator (colour board)**

```bash
scripts/pebble-emu-boot.sh emery
```

- [ ] **Step 2: Temporarily seed one online + one offline light for a headless screenshot**

The headless emulator cannot receive phone AppMessages, so seed a fake list at
the end of `load_persisted()` (in `src/c/pebble-tuya.c`) guarded so it only runs
when nothing is persisted. Add just before the final `rebuild_order();`:

```c
  if (s_light_count == 0) {   // TEMP seed for emulator screenshot — REVERT
    snprintf(s_lights[0].name, NAME_LEN, "Kitchen");
    s_lights[0].on = 1; s_lights[0].bright = 80; s_lights[0].temp = -1; s_lights[0].online = 1;
    snprintf(s_lights[1].name, NAME_LEN, "Garage");
    s_lights[1].on = 0; s_lights[1].bright = 0; s_lights[1].temp = -1; s_lights[1].online = 0;
    s_light_count = 2;
    s_state = ST_READY;
  }
```

- [ ] **Step 3: Build and install**

```bash
cd /home/dev/pebble-timetracking/PebbleTuyaControl
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble install --emulator emery
```

Expected: `App install succeeded`.

- [ ] **Step 4: Screenshot and inspect**

```bash
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble screenshot --no-open /tmp/tuya-offline.png
```

Expected: "Kitchen" row normal colour ("On · 80%"), "Garage" row greyed with
"Offline" subtitle. Surface the screenshot to the user with SendUserFile.

- [ ] **Step 5: Revert the temporary seed**

Remove the seed block added in Step 2.

```bash
git diff --stat   # expect: only the intended changes remain, no seed block
```

- [ ] **Step 6: Final commit (gitlink bump in superrepo)**

After the submodule commits are in place and the seed is reverted, bump the
superrepo gitlink:

```bash
cd /home/dev/pebble-timetracking
git add PebbleTuyaControl
git commit -m "Bump PebbleTuyaControl: offline lights disabled (no toggle/open, greyed)"
```
