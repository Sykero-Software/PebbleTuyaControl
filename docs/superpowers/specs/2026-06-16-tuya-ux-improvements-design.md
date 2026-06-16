# Tuya Lights — UX improvements design

Date: 2026-06-16

Three UX improvements to the PebbleTuyaControl watchapp, plus the shared
persistence/messaging infrastructure they need.

## Goals

1. **List quick-toggle** — a short middle-button (SELECT) press on a list row
   toggles that light on/off directly; a long press opens the control window.
   Configurable; the new behaviour is the default.
2. **Auto-close after toggle** — optional (off by default): after a toggle the
   app closes itself. Applies to toggles done in the list *and* in the control
   window. Closes only once the cloud command is confirmed (with a timeout
   fallback), so the light actually changes.
3. **Remembered state, usable immediately** — the watch persists the last known
   light list and shows it instantly on launch, so the user can toggle lights
   before fresh data has loaded. The app still fetches fresh state on launch and
   updates the UI silently when it arrives.

## Background / current behaviour

- `pebble-tuya.c` — list window (`MenuLayer`). `menu_select` (short SELECT)
  currently pushes the control window. State (`s_lights[]`, `s_light_count`)
  lives only in RAM; on launch `s_state = ST_LOADING` ("Loading…") until PKJS
  answers.
- `control-window.c` — control window. Short SELECT toggles; up/down adjust
  brightness/temp; long SELECT switches brightness/temp mode.
- `index.js` (PKJS) — `handleCommand(idx, action)` looks up `slots[idx]`; if the
  slots/caps are not loaded yet it **silently drops the command**
  (`if (!slot) return`). This is the bug behind "I toggled before data loaded
  and nothing happened".
- Tuya cloud calls run in PKJS, which **stops when the watchapp exits**
  (per Pebble docs: PebbleKit JS executes while the watchapp runs and stops once
  it exits). There is no background continuation — hence auto-close must wait for
  cloud confirmation before exiting.

## Constraint that shaped the design

PebbleKit JS has no background mode: in-flight HTTP requests are terminated when
the watchapp exits. Therefore "close instantly on press" cannot guarantee the
light changes. Auto-close waits for an explicit cloud-confirmation signal from
PKJS (with a timeout fallback) before exiting.

## Shared infrastructure

### Persistent light state (Feature 3)

- PebbleOS persistent storage caps each key at 256 bytes. `Light` is 48 bytes
  (`char name[32]` + 4 ints), so 12 lights = 576 bytes **does not fit one key**.
  → Store **one persist key per light** (`PERSIST_KEY_LIGHT_BASE + i`) plus a
  separate count key (`PERSIST_KEY_COUNT`).
- **Write** the snapshot in `deinit()` — captures the latest optimistic/confirmed
  states regardless of how the app exits (back button or auto-close).
- **Read** in `init()`: if `count > 0`, set `s_state = ST_READY` immediately so
  the cached list renders and is togglable before PKJS responds; otherwise
  `ST_LOADING` as today. PKJS then runs `loadAll()` and the inbox handler updates
  the rows silently as fresh data arrives. (No "updating…" indicator — cached
  state simply refreshes silently.)

### Command queue/replay in PKJS (Feature 3)

- Add `_pendingCmds = []`. In `handleCommand`, if `slots`/`caps` for the index
  are not ready, push `{idx, action}` and return instead of dropping it.
- After `loadAll()` completes (`pushRows()` done, caps loaded), drain
  `_pendingCmds` by re-invoking `handleCommand` for each. This honours a toggle
  issued against the cached list as soon as fresh data is available — even when
  the load is slow.
- Known minor cosmetic effect: `pushRows()` may briefly render a row's fresh
  (pre-toggle) state before the replayed command's confirmation arrives; it
  self-corrects when the command's `CmdDone`/row update lands. Acceptable for v1.

### Message keys

Append **only at the end** of `messageKeys` in `package.json`, then run
`pebble clean && pebble build` (a plain build caches the generated
`MESSAGE_KEY_*` macros and the C side fails to compile against the new names):

```
… "RowOnline", "CfgQuickToggle", "CfgAutoClose", "CmdDone"
```

- `CfgQuickToggle` (int 0/1) — phone → watch: quick-toggle setting.
- `CfgAutoClose` (int 0/1) — phone → watch: auto-close setting.
- `CmdDone` (int = light index) — phone → watch: sent in the command-success
  `.then` after the Tuya cloud POST resolves. Disambiguates a command
  confirmation from `loadAll`'s row pushes.

## Feature 1: list quick-toggle

- `menu_select` (short SELECT): if `CfgQuickToggle` is on and the row is valid
  and state is `ST_READY` → toggle `s_lights[row].on` optimistically,
  `send_command(row, ACT_TOGGLE)`, reload the menu. If `CfgQuickToggle` is off →
  current behaviour: `control_window_push(row)`.
- Add `MenuLayerCallbacks.select_long_click` → always `control_window_push(row)`.
- Works on cached state (`ST_READY` restored from persist).

## Feature 2: auto-close after toggle (opt-in)

Applies to the toggle action in the **list** and the **control window** (not
brightness/temp). When `CfgAutoClose` is on and the user toggles:

1. Optimistic update + `send_command(index, ACT_TOGGLE)`.
2. Enter pending-close: `s_close_pending_index = index`, push a lightweight
   modal **"Vaihdetaan…"** window, start a ~4 s `AppTimer`.
3. Inbox: when `CmdDone == s_close_pending_index` → `do_close()`
   (`window_stack_pop_all(true)` → app exits → `deinit()` persists state).
4. `ErrorMsg` while pending → cancel pending-close (pop the modal, cancel timer),
   show the error; do not exit.
5. Timeout fires → `do_close()` silently (fallback so it never hangs).

State/helpers (in `pebble-tuya.c`, shared via `tuya.h` so the control window can
trigger it): `s_close_pending_index` (-1 = none), `s_close_timer`,
`begin_auto_close(int index)`, `do_close()`, `cancel_auto_close()`.

## Config page (Clay, `config.js`)

Add a "Controls" section with two toggles:

- `CfgQuickToggle` — label "Tap in list toggles the light (hold to open
  controls)", **default on**.
- `CfgAutoClose` — label "Close the app after toggling", **default off**.

These are real `messageKeys` (sent to the watch). PKJS reads them from
`clay-settings` and sends them to the watch:

- On `ready` and on `webviewclosed`, send `{ CfgQuickToggle, CfgAutoClose }`
  (as ints) before/with the rows.
- Default derivation when a key is absent from `clay-settings`:
  `CfgQuickToggle` → 1, `CfgAutoClose` → 0.

The C side persists each on receipt (`persist_write_bool`) and reads them in
`init()` (defaults: quick-toggle on, auto-close off) so the setting already
applies on a cached launch before PKJS connects.

## Persist keys (C)

- `PERSIST_KEY_COUNT`
- `PERSIST_KEY_LIGHT_BASE + i` (i in 0..MAX_LIGHTS-1)
- `PERSIST_KEY_QUICK_TOGGLE`
- `PERSIST_KEY_AUTO_CLOSE`

## Testing

- **PKJS (jest):** unit-test the new pure logic — refactor the command
  queue/replay and the config-default derivation into testable functions and
  cover: a command queued before slots ready is replayed after `loadAll`; absent
  config keys derive to (quick=1, auto=0); present keys map to ints.
- **C (emulator screenshots):** diorite (144px) and emery (200px, the user's real
  Pebble Time 2 board). Verify the quick-toggle list (seed a cached state) and the
  "Vaihdetaan…" modal. Cloud-confirmed close needs a real watch (the emulator does
  not deliver phone AppMessages); on the emulator the ~4 s timeout fallback closes
  the app, which exercises the modal + close path.
- **Real watch (Core Devices, Pebble Time 2):** end-to-end — quick-toggle from the
  list, long-press opens controls, auto-close after a confirmed toggle, and a
  cached launch that is immediately togglable.

## Out of scope

- No background execution of cloud commands (not possible on PebbleKit JS).
- No "updating…" / staleness indicator on the cached list (silent refresh).
- No change to brightness/temp controls or to the credentials/region/poll config.
