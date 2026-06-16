# MRU-järjestetty valolista — design

Date: 2026-06-16
App: PebbleTuyaControl (Sykerö Tuya Lights)

## Goal

Make the light list order optionally reflect recency of use ("most recently
used", MRU). When enabled (default ON) the list shows **online** lights ordered
most-recently-used first; **offline** lights sink to the bottom. When disabled,
the current cloud order is preserved (today's behaviour).

The feature is fully watch-side (C). The only phone-side changes are the new
config toggle and its delivery to the watch.

## Decisions (from brainstorming)

- **Presentation:** reorder the single list (no separate "Recent" section), with
  offline devices forced to the bottom.
- **What counts as "use":** both the list tap-toggle AND control-window actions
  (on/off, brightness, colour temp). Merely *opening* the control window does not.
- **Persistence:** persisted across app restarts. Recency identity is the light's
  **name**.
- **Config:** one Clay on/off toggle, **default ON**.

## Architecture

`s_lights[MAX_LIGHTS]` stays in PKJS arrival order — it is **not** reordered.
Both persistence and PKJS row updates are index-based (`RowIndex`), so the array
order must remain stable. Display ordering is done through a separate index map.

### 1. MRU table (identity = name)

```c
static char s_mru[MAX_LIGHTS][NAME_LEN];  // names, most-recent first
static int  s_mru_count;
```

- `mark_used(const char *name)`: if `name` already present, remove it (shift the
  tail left); insert at front (index 0); cap `s_mru_count` at `MAX_LIGHTS`
  (drop the oldest on overflow).
- `mru_rank(const char *name)`: returns the index in `s_mru` (0 = most recent),
  or `s_mru_count` (a large sentinel) if the name is not present.

Empty / missing names are ignored by `mark_used`.

### 2. Display order

```c
static int s_order[MAX_LIGHTS];  // display row -> index into s_lights[]
```

`rebuild_order()` rebuilds `s_order` for the current `s_light_count`:

- **MRU off:** identity — `s_order[i] = i`.
- **MRU on:** insertion sort of indices `0..s_light_count-1` by composite key,
  lower sorts first:
  1. `online` desc — online (1) before offline (0).
  2. `mru_rank(name)` asc — more-recently-used first.
  3. arrival index asc — stable tie-break; never-used lights keep their cloud
     order at the tail of their online/offline group.

  Insertion sort is fine (≤ `MAX_LIGHTS` = 12 elements).

Called after every inbox update that can change rows/config and after
`load_persisted()`.

The three MenuLayer callbacks map the visible row to the real light index:
`int i = s_order[ci->row];` then use `s_lights[i]`. `menu_num_rows` is unchanged
(row count is the same; only order differs).

### 3. "Used" triggers

On each, call `mark_used(s_lights[i].name)` then `rebuild_order()` +
`menu_layer_reload_data`:

- `menu_select` (list tap-toggle) — for the toggled light.
- control-window actions in `control-window.c` (`up_click`, `down_click`,
  `select_click`) — via a new exported `void tuya_mark_used(int light_index);`
  declared in `tuya.h`, defined in `pebble-tuya.c`. **Not** called on
  `control_window_push` (opening) or on `select_long` (brightness/temp-mode
  toggle, no cloud command).

`tuya_mark_used(int light_index)` validates the index, calls `mark_used` with
that light's name, rebuilds order, and reloads the list menu.

### 4. Config — `CfgMru`

- **Clay** (`src/pkjs/config.js`): new `toggle`, `messageKey: "CfgMru"`,
  `defaultValue: true`, in the existing "Controls" section, label e.g.
  "Sort list by most-recently used (offline last)".
- **`package.json` messageKeys:** append `CfgMru` at the **end** of the list
  (positional/append-only rule). Run `pebble clean && pebble build` so the
  `MESSAGE_KEY_*` macros regenerate.
- **`tuya-lights.js` `cfgToInts`:** add `CfgMru` (default 1 when undefined, like
  `CfgQuickToggle`).
- **`index.js` `sendConfig`:** include `CfgMru` in the sent dict.
- **C (`pebble-tuya.c`):** `bool s_cfg_mru = true;` read in `inbox_received`
  (like `CfgQuickToggle`), persisted; `rebuild_order()` after a config change.

### 5. Persistence

New persist keys (existing: 100 count, 101 quick, 102 auto, 200 light base):

```c
#define PERSIST_KEY_MRU_ENABLED 103
#define PERSIST_KEY_MRU_COUNT   104
#define PERSIST_KEY_MRU_BASE    300   // + i, one name string per entry
```

- `save_persisted()`: write `s_cfg_mru`, `s_mru_count`, and each `s_mru[i]`
  (string) at `PERSIST_KEY_MRU_BASE + i`. (One key per name: `NAME_LEN` * 12 =
  384 B exceeds the 256 B per-key cap, so split as the light list already does.)
- `load_persisted()`: restore `s_cfg_mru` (if present), `s_mru_count`, and each
  name; then (after lights are restored) call `rebuild_order()`.
- `s_order` is recomputed, never persisted.

## Edge cases

- **Name no longer present in current list:** stays in the MRU table harmlessly;
  `mru_rank` simply never matches it. Self-prunes once the table fills to
  `MAX_LIGHTS`.
- **Duplicate light names:** treated as one identity (rare; acceptable — both
  rows get the same rank and fall back to arrival-index tie-break).
- **Recently used but offline:** still sorts below all online lights (offline at
  bottom), but keeps MRU order within the offline group.
- **First run / fresh install:** empty MRU table → all lights unseen → identity
  order, so MRU-on initially looks like the cloud order until lights are used.

## Testing / verification

- `cfgToInts` JS test (if a test suite exists) extended for `CfgMru` (default 1,
  explicit on/off).
- Emulator: temporarily seed `s_mru` in `load_persisted`'s no-persist branch,
  build/install/screenshot to confirm reordering + offline-at-bottom, then
  **revert the seed**. Surface the screenshot to the user.
- `scripts/check-pebble-message-keys.py` (if it covers Tuya) after appending the
  key.

## Out of scope

- Separate "Recent" section UI.
- Cross-device recency identity by Tuya device id (we use name per the decision).
- Configurable recent-count / pinning.
