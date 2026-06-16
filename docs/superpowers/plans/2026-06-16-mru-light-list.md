# MRU-Ordered Light List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable "most-recently-used" ordering to the Tuya light list — online lights sorted most-recent-first, offline lights at the bottom; default ON.

**Architecture:** `s_lights[]` stays in PKJS arrival order (persistence + row updates are index-based). Display goes through a separate `s_order[]` map rebuilt by `rebuild_order()`. Recency is tracked watch-side in a name-keyed MRU table (`s_mru[]`), updated on every list toggle and control-window action, persisted across restarts. A new Clay toggle `CfgMru` enables/disables sorting.

**Tech Stack:** Pebble SDK (C watchapp), PKJS (CommonJS), Clay config, jest for JS tests. The C side has **no unit-test harness** (Pebble SDK), so C tasks are verified by build + headless emulator screenshot per the repo convention; JS uses TDD with jest.

---

## File Structure

- `src/pkjs/tuya-lights.js` — add `CfgMru` to `cfgToInts` (testable pure fn).
- `tests/tuya-lights.test.js` — extend `cfgToInts` tests.
- `src/pkjs/index.js` — include `CfgMru` in `sendConfig`'s dict.
- `src/pkjs/config.js` — new Clay toggle in the "Controls" section.
- `package.json` — append `CfgMru` to `messageKeys`.
- `src/c/tuya.h` — declare `s_cfg_mru`, `tuya_mark_used`.
- `src/c/pebble-tuya.c` — MRU table, ordering, config receive, persistence, list-toggle trigger.
- `src/c/control-window.c` — call `tuya_mark_used` on actions.

---

## Task 1: JS config — `CfgMru` in `cfgToInts`

**Files:**
- Modify: `src/pkjs/tuya-lights.js:113-118`
- Test: `tests/tuya-lights.test.js:114-125`

- [ ] **Step 1: Update the failing tests**

Replace the `describe('cfgToInts', …)` block (lines 114-125) in `tests/tuya-lights.test.js` with:

```js
describe('cfgToInts', () => {
  test('defaults: quick-toggle on, auto-close off, mru on when keys absent', () => {
    expect(L.cfgToInts({})).toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0, CfgMru: 1 });
    expect(L.cfgToInts(undefined)).toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0, CfgMru: 1 });
  });
  test('maps booleans to ints', () => {
    expect(L.cfgToInts({ CfgQuickToggle: false, CfgAutoClose: true, CfgMru: false }))
      .toEqual({ CfgQuickToggle: 0, CfgAutoClose: 1, CfgMru: 0 });
    expect(L.cfgToInts({ CfgQuickToggle: true, CfgAutoClose: false, CfgMru: true }))
      .toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0, CfgMru: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tuya-lights`
Expected: FAIL — `cfgToInts` returns object without `CfgMru`.

- [ ] **Step 3: Implement `CfgMru` in `cfgToInts`**

In `src/pkjs/tuya-lights.js`, replace the body of `cfgToInts` (lines 113-118) with:

```js
function cfgToInts(settings) {
  var s = settings || {};
  var qt = (s.CfgQuickToggle === undefined) ? 1 : (s.CfgQuickToggle ? 1 : 0);
  var ac = s.CfgAutoClose ? 1 : 0;
  var mru = (s.CfgMru === undefined) ? 1 : (s.CfgMru ? 1 : 0);
  return { CfgQuickToggle: qt, CfgAutoClose: ac, CfgMru: mru };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tuya-lights`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/tuya-lights.js tests/tuya-lights.test.js
git commit -m "feat(pkjs): cfgToInts emits CfgMru (default on)"
```

---

## Task 2: Wire `CfgMru` through config + message keys

**Files:**
- Modify: `src/pkjs/index.js:31`
- Modify: `src/pkjs/config.js:52-58` (the "Controls" section)
- Modify: `package.json` (messageKeys)

- [ ] **Step 1: Send `CfgMru` to the watch**

In `src/pkjs/index.js`, replace line 31:

```js
  sendMsg({ CfgQuickToggle: c.CfgQuickToggle, CfgAutoClose: c.CfgAutoClose, CfgMru: c.CfgMru });
```

- [ ] **Step 2: Add the Clay toggle**

In `src/pkjs/config.js`, inside the "Controls" `section` `items` array, after the
`CfgAutoClose` toggle object (the one ending `"defaultValue": false }`), add:

```js
      { "type": "toggle", "messageKey": "CfgMru",
        "label": "Sort list by most-recently used (offline last)",
        "defaultValue": true },
```

- [ ] **Step 3: Append the message key**

In `package.json`, append `"CfgMru"` as the **last** entry of `pebble.messageKeys`
(after `"CmdDone"`). Append-only — do not reorder existing keys.

- [ ] **Step 4: Regenerate macros + build**

Run (in `PebbleTuyaControl/`):
```bash
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble clean && \
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build
```
Expected: build succeeds. (`pebble clean` is required so `MESSAGE_KEY_CfgMru`
regenerates — see CLAUDE.md.) The C side does not reference `MESSAGE_KEY_CfgMru`
yet; it is added in Task 5.

- [ ] **Step 5: Run the message-key check (if it covers Tuya)**

Run: `python3 ../scripts/check-pebble-message-keys.py || true`
Expected: PASS, or no Tuya coverage (harmless). Investigate only a real mismatch.

- [ ] **Step 6: Commit**

```bash
git add src/pkjs/index.js src/pkjs/config.js package.json
git commit -m "feat: append CfgMru message key + Clay toggle, send to watch"
```

---

## Task 3: C — MRU table + ordering core (display through `s_order`)

**Files:**
- Modify: `src/c/pebble-tuya.c` (add state + helpers near top; route menu callbacks through `s_order`; rebuild in inbox)

At this point `mark_used` is not yet called from any trigger, so the visible order
stays identity — the change is structurally inert but must compile and behave as
today.

- [ ] **Step 1: Add MRU/order state + helpers**

In `src/c/pebble-tuya.c`, after the `s_cfg_quick_toggle`/`s_cfg_auto_close`
declarations (after line 23), add:

```c
// --- MRU (most-recently-used) ordering --------------------------------------
// Recency identity is the light NAME (see spec). s_mru holds names most-recent
// first; s_order maps a display row to an index into s_lights[].
bool s_cfg_mru = true;                       // default ON (matches Clay defaultValue)
static char s_mru[MAX_LIGHTS][NAME_LEN];
static int  s_mru_count = 0;
static int  s_order[MAX_LIGHTS];

static int mru_rank(const char *name) {
  for (int i = 0; i < s_mru_count; i++) {
    if (strncmp(s_mru[i], name, NAME_LEN) == 0) return i;
  }
  return s_mru_count;   // unseen -> sorts after all seen names
}

static void mark_used(const char *name) {
  if (!name || !name[0]) return;
  int found = -1;
  for (int i = 0; i < s_mru_count; i++) {
    if (strncmp(s_mru[i], name, NAME_LEN) == 0) { found = i; break; }
  }
  if (found < 0) {
    if (s_mru_count < MAX_LIGHTS) s_mru_count++;
    found = s_mru_count - 1;            // overflow: reuse the last slot (drop oldest)
  }
  for (int i = found; i > 0; i--) strncpy(s_mru[i], s_mru[i - 1], NAME_LEN);
  strncpy(s_mru[0], name, NAME_LEN - 1);
  s_mru[0][NAME_LEN - 1] = '\0';
}

// true if light index a should sort before b: online first, then more-recent, then arrival.
static bool order_less(int a, int b) {
  if (s_lights[a].online != s_lights[b].online)
    return s_lights[a].online > s_lights[b].online;
  int ra = mru_rank(s_lights[a].name), rb = mru_rank(s_lights[b].name);
  if (ra != rb) return ra < rb;
  return a < b;
}

static void rebuild_order(void) {
  int n = s_light_count; if (n > MAX_LIGHTS) n = MAX_LIGHTS;
  for (int i = 0; i < n; i++) s_order[i] = i;
  if (!s_cfg_mru) return;
  for (int i = 1; i < n; i++) {            // stable insertion sort (n <= 12)
    int cur = s_order[i], j = i - 1;
    while (j >= 0 && order_less(cur, s_order[j])) { s_order[j + 1] = s_order[j]; j--; }
    s_order[j + 1] = cur;
  }
}
```

- [ ] **Step 2: Route the three menu callbacks through `s_order`**

In `menu_draw_row` (line 58), replace `Light *l = &s_lights[ci->row];` with:

```c
  int li = (ci->row < s_light_count) ? s_order[ci->row] : ci->row;
  Light *l = &s_lights[li];
```

In `menu_select` (lines 69-71), replace:

```c
  int row = ci->row;
  if (row >= s_light_count) return;
  s_lights[row].on = !s_lights[row].on;   // optimistic; PKJS pushes authoritative state back
  send_command(row, ACT_TOGGLE);
```
with:
```c
  if (ci->row >= s_light_count) return;
  int row = s_order[ci->row];
  s_lights[row].on = !s_lights[row].on;   // optimistic; PKJS pushes authoritative state back
  send_command(row, ACT_TOGGLE);
```
(The later `begin_auto_close(row)` already uses `row` and is now correct.)

In `menu_select_long` (lines 79-80), replace:

```c
  if (ci->row >= s_light_count) return;
  control_window_push(ci->row);   // long press always opens the control window
```
with:
```c
  if (ci->row >= s_light_count) return;
  control_window_push(s_order[ci->row]);   // long press always opens the control window
```

- [ ] **Step 3: Rebuild order after each inbox update**

In `inbox_received`, immediately before `list_window_reload();` (line 139), add:

```c
  rebuild_order();
```

- [ ] **Step 4: Build to verify it compiles**

Run (in `PebbleTuyaControl/`):
```bash
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build
```
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/c/pebble-tuya.c
git commit -m "feat(watch): s_order display map + name-keyed MRU table + sort"
```

---

## Task 4: C — recency triggers (list toggle + control window)

**Files:**
- Modify: `src/c/tuya.h` (declare `tuya_mark_used`)
- Modify: `src/c/pebble-tuya.c` (define `tuya_mark_used`; mark on list toggle)
- Modify: `src/c/control-window.c` (mark on actions)

- [ ] **Step 1: Declare `tuya_mark_used`**

In `src/c/tuya.h`, in the `// pebble-tuya.c` group (after the `begin_auto_close` line, line 31), add:

```c
void tuya_mark_used(int light_index);  // record recency for a light + reorder the list
```

- [ ] **Step 2: Define `tuya_mark_used` + mark on list toggle**

In `src/c/pebble-tuya.c`, add this definition immediately **after** the
`list_window_reload` function (after its closing brace, line 103) — placing it
there keeps `list_window_reload`, `mark_used`, and `rebuild_order` all in scope,
avoiding an implicit-declaration warning:

```c
void tuya_mark_used(int light_index) {
  if (light_index < 0 || light_index >= s_light_count) return;
  mark_used(s_lights[light_index].name);
  rebuild_order();
  list_window_reload();
}
```

In `menu_select`, after `send_command(row, ACT_TOGGLE);` and before
`menu_layer_reload_data(s_menu);`, add:

```c
  mark_used(s_lights[row].name);
  rebuild_order();
```
(The existing `menu_layer_reload_data(s_menu);` then redraws in the new order.)

- [ ] **Step 3: Mark on control-window actions**

In `src/c/control-window.c`:

In `up_click`, add as the last line (after `render();`, line 34):
```c
  tuya_mark_used(s_index);
```
In `down_click`, add as the last line (after `render();`, line 41):
```c
  tuya_mark_used(s_index);
```
In `select_click`, after `render();` (line 47) and before the `if (s_cfg_auto_close)` line:
```c
  tuya_mark_used(s_index);
```
(The `temp < 0` early `return`s in up/down mean reaching the end implies a command
was sent. `select_long` is intentionally NOT marked — it only toggles bright/temp
mode, no cloud command.)

- [ ] **Step 4: Build to verify it compiles**

Run: `PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build`
Expected: build succeeds, no implicit-declaration warning for `tuya_mark_used`.

- [ ] **Step 5: Commit**

```bash
git add src/c/tuya.h src/c/pebble-tuya.c src/c/control-window.c
git commit -m "feat(watch): mark recency on list toggle + control-window actions"
```

---

## Task 5: C — receive `CfgMru` + persist MRU state

**Files:**
- Modify: `src/c/pebble-tuya.c` (persist keys, inbox config read, save/load)

- [ ] **Step 1: Add persist keys**

In `src/c/pebble-tuya.c`, after `#define PERSIST_KEY_LIGHT_BASE   200   // + i`
(line 20), add:

```c
#define PERSIST_KEY_MRU_ENABLED  103
#define PERSIST_KEY_MRU_COUNT    104
#define PERSIST_KEY_MRU_BASE     300   // + i, one name string per entry
```

- [ ] **Step 2: Receive `CfgMru` in the inbox**

In `inbox_received`, after the `CfgAutoClose` block (lines 120-121), add:

```c
  Tuple *mru = dict_find(it, MESSAGE_KEY_CfgMru);
  if (mru) { s_cfg_mru = mru->value->int32 ? true : false; persist_write_bool(PERSIST_KEY_MRU_ENABLED, s_cfg_mru); }
```
(The `rebuild_order();` added in Task 3 before `list_window_reload();` already
re-sorts after this config change.)

- [ ] **Step 3: Persist the MRU state on save**

In `save_persisted`, after the `persist_write_bool(PERSIST_KEY_AUTO_CLOSE, …)`
line (line 174), add:

```c
  persist_write_bool(PERSIST_KEY_MRU_ENABLED, s_cfg_mru);
  persist_write_int(PERSIST_KEY_MRU_COUNT, s_mru_count);
  for (int i = 0; i < s_mru_count && i < MAX_LIGHTS; i++) {
    persist_write_string(PERSIST_KEY_MRU_BASE + i, s_mru[i]);
  }
```

- [ ] **Step 4: Restore the MRU state on load + rebuild order**

In `load_persisted`, after the `PERSIST_KEY_AUTO_CLOSE` restore line (line 156),
add:

```c
  if (persist_exists(PERSIST_KEY_MRU_ENABLED)) s_cfg_mru = persist_read_bool(PERSIST_KEY_MRU_ENABLED);
  if (persist_exists(PERSIST_KEY_MRU_COUNT)) {
    int m = persist_read_int(PERSIST_KEY_MRU_COUNT);
    if (m > MAX_LIGHTS) m = MAX_LIGHTS;
    int mv = 0;
    for (int i = 0; i < m; i++) {
      if (!persist_exists(PERSIST_KEY_MRU_BASE + i)) break;
      persist_read_string(PERSIST_KEY_MRU_BASE + i, s_mru[mv], NAME_LEN);
      mv++;
    }
    s_mru_count = mv;
  }
```

Then at the very end of `load_persisted` (after the `if (valid > 0) …` line, line 169), add:

```c
  rebuild_order();
```

- [ ] **Step 5: Build to verify it compiles**

Run: `PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build`
Expected: build succeeds (`MESSAGE_KEY_CfgMru` resolves — it was added to
messageKeys + `pebble clean`ed in Task 2).

- [ ] **Step 6: Commit**

```bash
git add src/c/pebble-tuya.c
git commit -m "feat(watch): receive CfgMru + persist MRU table/enable across restarts"
```

---

## Task 6: Emulator verification + gitlink bump

**Files:**
- Temporarily modify (then REVERT): `src/c/pebble-tuya.c` (`load_persisted` seed)
- Modify (superrepo): gitlink for `PebbleTuyaControl`

- [ ] **Step 1: Boot the emulator (Pebble Time 2 board)**

Run (from repo root `/home/dev/pebble-timetracking`):
```bash
scripts/pebble-emu-boot.sh emery
```
Expected: boots within ~1-2 attempts; then stays up.

- [ ] **Step 2: Seed lights + MRU for a screenshot (TEMPORARY)**

In `src/c/pebble-tuya.c`, at the **top** of `load_persisted()` (before any other
code), add this seed block (no phone is available headless, so we fake state):

```c
  // TEMP SEED for emulator screenshot — REVERT before commit.
  s_light_count = 4; s_state = ST_READY;
  strncpy(s_lights[0].name, "Kitchen", NAME_LEN); s_lights[0].online = 1; s_lights[0].on = 1; s_lights[0].bright = 80;
  strncpy(s_lights[1].name, "Bedroom", NAME_LEN); s_lights[1].online = 1; s_lights[1].on = 0;
  strncpy(s_lights[2].name, "Hall",    NAME_LEN); s_lights[2].online = 0;
  strncpy(s_lights[3].name, "Desk",    NAME_LEN); s_lights[3].online = 1; s_lights[3].on = 1; s_lights[3].bright = 50;
  strncpy(s_mru[0], "Desk", NAME_LEN); strncpy(s_mru[1], "Kitchen", NAME_LEN); s_mru_count = 2;
  rebuild_order();
  return;
```

- [ ] **Step 3: Build, install, screenshot**

Run as **separate** Bash calls (in `PebbleTuyaControl/`; do not `&&`-chain install+screenshot per CLAUDE.md):
```bash
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build
```
```bash
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble install --emulator emery
```
```bash
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble screenshot --no-open mru-shot.png
```
Expected list order (MRU on): **Desk** (recent), **Kitchen** (recent), **Bedroom**
(online unseen), then **Hall** (offline, bottom). Surface `mru-shot.png` to the
user with `SendUserFile`.

- [ ] **Step 4: Revert the seed**

Remove the TEMP SEED block from `load_persisted()`. Verify it's gone:
```bash
git diff src/c/pebble-tuya.c | grep -c "TEMP SEED"
```
Expected: `0`.

- [ ] **Step 5: Rebuild clean (no seed) + final JS tests**

```bash
PEBBLE_QEMU_PATH=~/.local/bin/qemu-pebble-headless pebble build && npm test
```
Expected: build succeeds; all jest tests pass.

- [ ] **Step 6: Commit submodule + bump gitlink in superrepo**

```bash
git -C /home/dev/pebble-timetracking/PebbleTuyaControl add -A
git -C /home/dev/pebble-timetracking/PebbleTuyaControl commit -m "chore: verified MRU list on emery emulator (seed reverted)" || echo "nothing to commit"
cd /home/dev/pebble-timetracking
git add PebbleTuyaControl
git commit -m "Bump PebbleTuyaControl: configurable MRU-ordered light list"
```

- [ ] **Step 7: Clean up the emulator**

Run: `pebble kill; pkill -x qemu-pebble || true`
(Leftover `qemu-pebble` spins at 100% CPU — kill by exact name only, never `-f`.)

---

## Notes for the implementer

- **Never reorder `package.json` messageKeys** — IDs are positional (`10000 + index`).
  Only append. After editing messageKeys, `pebble clean && pebble build` (macros are cached).
- **`s_lights[]` is never reordered** — only `s_order[]` is. Persistence and PKJS
  `RowIndex` updates both assume arrival order.
- No `strtol`/`atol` here (none added) — those are unexported on Core Devices firmware (CLAUDE.md).
- Surface every emulator screenshot to the user via `SendUserFile`.
