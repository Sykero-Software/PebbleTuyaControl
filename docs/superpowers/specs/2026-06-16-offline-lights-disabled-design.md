# Offline lights are disabled — design

**Date:** 2026-06-16
**Status:** Approved

## Problem

Lights reported as offline by the Tuya cloud can currently still be toggled on
the watch. The `Light.online` flag already flows end-to-end (Tuya `d.online` →
PKJS `RowOnline` → watch `s_lights[i].online`) and is rendered as an "Offline"
subtitle, but neither the list quick-toggle nor the control window checks it
before sending an `ACT_TOGGLE`. An offline device cannot act on the command, so
the optimistic UI flips a state that never takes effect.

## Goal

Treat offline lights as **disabled**: visually greyed, not togglable, and not
openable into the control window. Attempting to act on one is a **silent no-op**
(no vibration, no message).

## Scope

C-side UI logic only. No changes to PKJS, message keys (`RowOnline` already
carries the status), persistence, or list ordering (offline lights already sort
to the bottom in `mapDevicesToSlots`).

## Changes

### 1. Visual — list rendering (`menu_draw_row`, `pebble-tuya.c`)

For an offline row, draw the cell text in **grey** (`GColorLightGray`) instead of
the normal colour, so the row reads as disabled. The "Offline" subtitle stays as
is. Honour the highlighted/selected state as `menu_cell_basic_draw` normally
does; the grey applies to the disabled row's foreground.

- On colour boards (Pebble Time 2 / flint — the real test watch) the grey shows.
- On 1-bit boards it degrades to black; acceptable, not a target device.

### 2. List toggle / open (`menu_select`, `pebble-tuya.c`)

Immediately after resolving the selected light index, guard:

```c
if (!s_lights[row].online) return;   // offline = disabled, silent no-op
```

This covers both modes:
- Quick-toggle ON: SELECT no longer toggles an offline light.
- Classic (quick-toggle OFF): SELECT no longer opens the control window for one.

### 3. Long SELECT (`menu_select_long`, `pebble-tuya.c`)

Same `online` guard before `control_window_push` — an offline light cannot be
opened into the control window.

### 4. Control window toggle (`select_click`, `control-window.c`)

Defensive guard: `if (!s_lights[s_index].online) return;` before the optimistic
toggle. The window should be unreachable for an offline light via the menu
guards, but this keeps behaviour consistent if a light goes offline while its
control window is already open.

## Out of scope / unchanged

- PKJS (`index.js`, `tuya-lights.js`), message keys, Clay config.
- Persistence (`load_persisted`/`save_persisted`) — the `online` flag is already
  part of the persisted `Light` struct.
- List ordering — offline lights already pushed to the bottom.

## Testing

- Build for emery (colour) and verify offline rows render grey.
- Confirm short/long SELECT on an offline row does nothing (no state flip, no
  vibration, control window does not open).
- Confirm online rows behave exactly as before.
