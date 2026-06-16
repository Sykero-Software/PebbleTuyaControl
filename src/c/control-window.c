#include <pebble.h>
#include "tuya.h"

#define STEP 20  // percent per press — mirror L.actionToCommands in tuya-lights.js

static Window *s_ctrl_window;   // created once, reused across pushes (no per-push leak)
static TextLayer *s_title, *s_value, *s_hint;
static int s_index;
static int s_temp_mode = 0; // 0 = brightness, 1 = colour temp
static bool s_loaded = false;

static int clamp_pct(int v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

static void render(void) {
  if (!s_loaded || s_index < 0 || s_index >= s_light_count) return;
  Light *l = &s_lights[s_index];
  const char *statusw = !l->online ? "Offline" : (l->on ? "On" : "Off");
  static char val[48];
  if (s_temp_mode) snprintf(val, sizeof(val), "%s\nTemp %d%%", statusw, l->temp < 0 ? 0 : l->temp);
  else snprintf(val, sizeof(val), "%s\nBright %d%%", statusw, l->bright);
  text_layer_set_text(s_title, l->name);
  text_layer_set_text(s_value, val);
  text_layer_set_text(s_hint, s_temp_mode ? "Up/Dn temp, hold=bright" : "Up/Dn bright, hold=temp");
}

// Optimistic UI: update the local state immediately and re-render, then fire the
// command. PKJS pushes the authoritative state back on completion (and reverts to
// the last known state if the command fails), so the watch self-corrects.
static void up_click(ClickRecognizerRef r, void *ctx) {
  if (s_index >= s_light_count) return;
  Light *l = &s_lights[s_index];
  if (s_temp_mode) { if (l->temp < 0) return; l->temp = clamp_pct(l->temp + STEP); send_command(s_index, ACT_TEMP_UP); }
  else { l->bright = clamp_pct(l->bright + STEP); send_command(s_index, ACT_BRIGHT_UP); }
  render();
  tuya_mark_used(s_index);
}
static void down_click(ClickRecognizerRef r, void *ctx) {
  if (s_index >= s_light_count) return;
  Light *l = &s_lights[s_index];
  if (s_temp_mode) { if (l->temp < 0) return; l->temp = clamp_pct(l->temp - STEP); send_command(s_index, ACT_TEMP_DOWN); }
  else { l->bright = clamp_pct(l->bright - STEP); send_command(s_index, ACT_BRIGHT_DOWN); }
  render();
  tuya_mark_used(s_index);
}
static void select_click(ClickRecognizerRef r, void *ctx) {
  if (s_index >= s_light_count) return;
  s_lights[s_index].on = !s_lights[s_index].on;
  send_command(s_index, ACT_TOGGLE);
  render();
  tuya_mark_used(s_index);
  if (s_cfg_auto_close) begin_auto_close(s_index);   // declared in tuya.h
}
static void select_long(ClickRecognizerRef r, void *ctx) {
  if (s_index < s_light_count && s_lights[s_index].temp >= 0) { s_temp_mode = !s_temp_mode; render(); }
}

static void click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, select_long, NULL);
}

static void ctrl_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  GRect b = layer_get_bounds(root);
  s_title = text_layer_create(GRect(4, 8, b.size.w - 8, 40));
  text_layer_set_font(s_title, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_title, GTextAlignmentCenter);
  s_value = text_layer_create(GRect(4, 56, b.size.w - 8, 70));
  text_layer_set_font(s_value, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_text_alignment(s_value, GTextAlignmentCenter);
  s_hint = text_layer_create(GRect(4, b.size.h - 24, b.size.w - 8, 20));
  text_layer_set_font(s_hint, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_hint, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_title));
  layer_add_child(root, text_layer_get_layer(s_value));
  layer_add_child(root, text_layer_get_layer(s_hint));
  s_loaded = true;
  render();
}

static void ctrl_unload(Window *w) {
  text_layer_destroy(s_title); text_layer_destroy(s_value); text_layer_destroy(s_hint);
  s_loaded = false;
}

// Called by the list window's inbox handler after a row update, to refresh if showing.
void control_window_refresh(int index) {
  if (s_ctrl_window && window_stack_get_top_window() == s_ctrl_window && index == s_index) render();
}

void control_window_push(int index) {
  s_index = index;
  s_temp_mode = 0;
  if (!s_ctrl_window) {
    s_ctrl_window = window_create();
    window_set_window_handlers(s_ctrl_window, (WindowHandlers){ .load = ctrl_load, .unload = ctrl_unload });
    window_set_click_config_provider(s_ctrl_window, click_config);
  }
  window_stack_push(s_ctrl_window, true);  // load fires -> render() with the new s_index
}

void control_window_deinit(void) {
  if (s_ctrl_window) { window_destroy(s_ctrl_window); s_ctrl_window = NULL; }
}
