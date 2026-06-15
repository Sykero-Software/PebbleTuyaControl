#include <pebble.h>
#include "tuya.h"

Light s_lights[MAX_LIGHTS];   // file-scope: shared with control-window.c via tuya.h
int s_light_count = 0;
static int s_ready = 0;       // 0 = not configured / loading
static char s_error[64] = "";

static Window *s_list_window;
static MenuLayer *s_menu;
static StatusBarLayer *s_status;

// --- AppMessage send ---
void send_command(int index, int action) {
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) return;
  dict_write_int32(it, MESSAGE_KEY_CmdLightIndex, index);
  dict_write_int32(it, MESSAGE_KEY_CmdAction, action);
  app_message_outbox_send();
}

// --- MenuLayer callbacks ---
static uint16_t menu_num_rows(MenuLayer *m, uint16_t section, void *ctx) {
  if (s_error[0]) return 1;
  if (!s_ready) return 1;
  return s_light_count == 0 ? 1 : s_light_count;
}

static void menu_draw_row(GContext *g, const Layer *cell, MenuIndex *ci, void *ctx) {
  if (s_error[0]) { menu_cell_basic_draw(g, cell, "Error", s_error, NULL); return; }
  if (!s_ready) { menu_cell_basic_draw(g, cell, "Tuya Lights", "Configure on phone…", NULL); return; }
  if (s_light_count == 0) { menu_cell_basic_draw(g, cell, "No lights found", NULL, NULL); return; }
  Light *l = &s_lights[ci->row];
  static char sub[24];
  if (!l->online) snprintf(sub, sizeof(sub), "Offline");
  else if (l->on) snprintf(sub, sizeof(sub), "On · %d%%", l->bright);
  else snprintf(sub, sizeof(sub), "Off");
  menu_cell_basic_draw(g, cell, l->name, sub, NULL);
}

static void menu_select(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (!s_ready || s_light_count == 0 || s_error[0]) return;
  control_window_push(ci->row);
}

static void list_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  GRect b = layer_get_bounds(root);
  s_status = status_bar_layer_create();
  s_menu = menu_layer_create(GRect(0, STATUS_BAR_LAYER_HEIGHT, b.size.w, b.size.h - STATUS_BAR_LAYER_HEIGHT));
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks){
    .get_num_rows = menu_num_rows, .draw_row = menu_draw_row, .select_click = menu_select });
  menu_layer_set_click_config_onto_window(s_menu, w);
  layer_add_child(root, menu_layer_get_layer(s_menu));
  layer_add_child(root, status_bar_layer_get_layer(s_status));
}

static void list_unload(Window *w) {
  menu_layer_destroy(s_menu);
  status_bar_layer_destroy(s_status);
}

void list_window_reload(void) {
  if (s_menu) menu_layer_reload_data(s_menu);
}

// --- AppMessage receive ---
static void inbox_received(DictionaryIterator *it, void *ctx) {
  Tuple *t;
  if ((t = dict_find(it, MESSAGE_KEY_ErrorMsg))) {
    strncpy(s_error, t->value->cstring, sizeof(s_error) - 1);
    s_error[sizeof(s_error) - 1] = '\0';
    s_ready = 1; list_window_reload(); return;
  }
  if ((t = dict_find(it, MESSAGE_KEY_Ready))) {
    s_ready = t->value->int32;
    s_error[0] = '\0';
  }
  if ((t = dict_find(it, MESSAGE_KEY_ListCount))) {
    s_light_count = t->value->int32;
    if (s_light_count > MAX_LIGHTS) s_light_count = MAX_LIGHTS;
  }
  Tuple *idx_t = dict_find(it, MESSAGE_KEY_RowIndex);
  if (idx_t) {
    int i = idx_t->value->int32;
    if (i >= 0 && i < MAX_LIGHTS) {
      Tuple *n = dict_find(it, MESSAGE_KEY_RowName);
      if (n) { strncpy(s_lights[i].name, n->value->cstring, NAME_LEN - 1); s_lights[i].name[NAME_LEN - 1] = '\0'; }
      Tuple *on = dict_find(it, MESSAGE_KEY_RowOn);     if (on) s_lights[i].on = on->value->int32;
      Tuple *br = dict_find(it, MESSAGE_KEY_RowBright); if (br) s_lights[i].bright = br->value->int32;
      Tuple *tp = dict_find(it, MESSAGE_KEY_RowTemp);   if (tp) s_lights[i].temp = tp->value->int32;
      Tuple *ol = dict_find(it, MESSAGE_KEY_RowOnline); if (ol) s_lights[i].online = ol->value->int32;
      if (i + 1 > s_light_count) s_light_count = i + 1;
    }
  }
  list_window_reload();
  if (idx_t) control_window_refresh(idx_t->value->int32);
}

static void outbox_failed(DictionaryIterator *it, AppMessageResult reason, void *ctx) {
  // Required on real hardware: the phone ACKs outbound messages and the SDK
  // dispatches the result callback. A missing handler hard-faults (CLAUDE.md).
}

static void outbox_sent(DictionaryIterator *it, void *ctx) {}

static void init(void) {
  app_message_register_inbox_received(inbox_received);
  app_message_register_outbox_sent(outbox_sent);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(512, 256);

  s_list_window = window_create();
  window_set_window_handlers(s_list_window, (WindowHandlers){ .load = list_load, .unload = list_unload });
  window_stack_push(s_list_window, true);
}

static void deinit(void) {
  control_window_deinit();
  window_destroy(s_list_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
