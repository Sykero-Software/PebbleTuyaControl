#pragma once
#include <pebble.h>

#define MAX_LIGHTS 12
#define NAME_LEN 32

// CmdAction enum — must match L.ACTIONS in tuya-lights.js.
enum {
  ACT_REFRESH = 0, ACT_TOGGLE = 1, ACT_BRIGHT_UP = 2,
  ACT_BRIGHT_DOWN = 3, ACT_TEMP_UP = 4, ACT_TEMP_DOWN = 5
};

typedef struct {
  char name[NAME_LEN];
  int on;       // 0/1
  int bright;   // 0-100
  int temp;     // 0-100, -1 = unsupported
  int online;   // 0/1 reachability
} Light;

// Shared light state — defined in pebble-tuya.c.
extern Light s_lights[MAX_LIGHTS];
extern int s_light_count;

// pebble-tuya.c
void send_command(int index, int action);

// control-window.c
void control_window_push(int index);
void control_window_refresh(int index);
void control_window_deinit(void);
