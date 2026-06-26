#include <pebble.h>
#include "tuya.h"

#define STEP 20  // percent per press — mirror L.actionToCommands in tuya-lights.js

static Window *s_ctrl_window;   // created once, reused across pushes (no per-push leak)
static TextLayer *s_title, *s_value, *s_hint;
static char s_ctrl_id[ID_LEN];  // the open light's stable id; index re-resolved per action
static int s_temp_mode = 0; // 0 = brightness, 1 = colour temp
static bool s_loaded = false;

static int clamp_pct(int v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

// The list can be reordered asynchronously while this window is open, so never cache
// an index — resolve the current s_lights[] position from the stable id each time.
static int ctrl_index(void) { return find_light_by_id(s_ctrl_id); }

static void render(void) {
  int idx = ctrl_index();
  if (!s_loaded || idx < 0) return;
  Light *l = &s_lights[idx];
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
  int i = ctrl_index();
  if (i < 0) return;
  Light *l = &s_lights[i];
  if (s_temp_mode) { if (l->temp < 0) return; l->temp = clamp_pct(l->temp + STEP); send_command(i, ACT_TEMP_UP, -1); }
  else { l->bright = clamp_pct(l->bright + STEP); send_command(i, ACT_BRIGHT_UP, -1); }
  render();
  tuya_mark_used(i);
}
static void down_click(ClickRecognizerRef r, void *ctx) {
  int i = ctrl_index();
  if (i < 0) return;
  Light *l = &s_lights[i];
  if (s_temp_mode) { if (l->temp < 0) return; l->temp = clamp_pct(l->temp - STEP); send_command(i, ACT_TEMP_DOWN, -1); }
  else { l->bright = clamp_pct(l->bright - STEP); send_command(i, ACT_BRIGHT_DOWN, -1); }
  render();
  tuya_mark_used(i);
}
static void select_click(ClickRecognizerRef r, void *ctx) {
  int i = ctrl_index();
  if (i < 0) return;
  if (!s_lights[i].online) return;   // offline = disabled, silent no-op
  Light prev = s_lights[i];          // confirmed state, restored if the command is unconfirmed
  int desired_on = s_lights[i].on ? 0 : 1;
  s_lights[i].on = desired_on;
  send_command(i, ACT_TOGGLE, desired_on);
  render();
  tuya_mark_used(i);
  if (s_cfg_auto_close) begin_auto_close(i, &prev);   // declared in tuya.h
}
static void select_long(ClickRecognizerRef r, void *ctx) {
  int i = ctrl_index();
  if (i >= 0 && s_lights[i].temp >= 0) { s_temp_mode = !s_temp_mode; render(); }
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
void control_window_refresh(const char *id) {
  if (s_ctrl_window && window_stack_get_top_window() == s_ctrl_window
      && id && s_ctrl_id[0] && strcmp(id, s_ctrl_id) == 0) render();
}

void control_window_push(int index) {
  if (index < 0 || index >= s_light_count) return;
  strncpy(s_ctrl_id, s_lights[index].id, ID_LEN - 1);
  s_ctrl_id[ID_LEN - 1] = '\0';
  s_temp_mode = 0;
  if (!s_ctrl_window) {
    s_ctrl_window = window_create();
    window_set_window_handlers(s_ctrl_window, (WindowHandlers){ .load = ctrl_load, .unload = ctrl_unload });
    window_set_click_config_provider(s_ctrl_window, click_config);
  }
  window_stack_push(s_ctrl_window, true);  // load fires -> render() for the new s_ctrl_id
}

void control_window_deinit(void) {
  if (s_ctrl_window) { window_destroy(s_ctrl_window); s_ctrl_window = NULL; }
}
