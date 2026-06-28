#pragma once
#include <pebble.h>

#define MAX_LIGHTS 12
#define NAME_LEN 32
#define ID_LEN 32   // Tuya device id (~20-22 chars); the STABLE light identifier

// CmdAction enum — must match L.ACTIONS in tuya-lights.js.
enum {
  ACT_REFRESH = 0, ACT_TOGGLE = 1, ACT_BRIGHT_UP = 2,
  ACT_BRIGHT_DOWN = 3, ACT_TEMP_UP = 4, ACT_TEMP_DOWN = 5
};

typedef struct {
  char name[NAME_LEN];
  char id[ID_LEN];   // stable Tuya device id — used to address commands (not the array index)
  int on;       // 0/1
  int bright;   // 0-100
  int temp;     // 0-100, -1 = unsupported
  int online;   // 0/1 reachability
} Light;

// Shared light state — defined in pebble-tuya.c.
extern Light s_lights[MAX_LIGHTS];
extern int s_light_count;
// Control settings — defined in pebble-tuya.c, set from the phone (CfgQuickToggle/
// CfgAutoClose) and persisted. control-window.c reads s_cfg_auto_close.
extern bool s_cfg_quick_toggle;
extern bool s_cfg_auto_close;

// pebble-tuya.c
int  find_light_by_id(const char *id);   // -> s_lights[] index for a stable id, or -1
// desired_on: 0/1 = absolute target for a TOGGLE (derived from the displayed state);
// -1 = omit (brightness/temp steps stay relative).
void send_command(int index, int action, int desired_on);
// Show "Switching…" and close once the phone confirms the command (CmdDone). `prev`
// is the light's pre-command state: if no confirmation arrives, the change is reverted
// to it and an error shown (the app stays open) rather than exiting as if it succeeded.
void begin_auto_close(int index, const Light *prev);
void tuya_mark_used(int light_index);  // record recency for a light + reorder the list

// Idle auto-exit (return to watchface after inactivity). Defined in pebble-tuya.c;
// the control window arms it on .appear, cancels on .disappear, and resets it on
// every button press.
void idle_reset(void);
void idle_cancel(void);
void idle_appear(Window *w);
void idle_disappear(Window *w);

// control-window.c
void control_window_push(int index);
void control_window_refresh(const char *id);   // re-render iff the open light matches this id
void control_window_deinit(void);
