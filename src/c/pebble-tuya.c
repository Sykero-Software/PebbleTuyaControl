#include <pebble.h>
#include "tuya.h"

Light s_lights[MAX_LIGHTS];   // file-scope: shared with control-window.c via tuya.h
int s_light_count = 0;

// Tri-state so the watch can tell "still loading" apart from "not configured":
//  LOADING   — initial, before PKJS has answered (configured apps spend a moment here)
//  READY     — PKJS sent Ready:1 (+ rows)
//  NOCONFIG  — PKJS sent Ready:0 (no credentials entered yet)
enum { ST_LOADING = 0, ST_READY = 1, ST_NOCONFIG = 2 };
static int s_state = ST_LOADING;
static char s_error[64] = "";

// Persist keys. Each Light is 48 bytes (< the 256-byte per-key cap), but 12 of them
// (576 bytes) do NOT fit one key — so store one key per light + a count key.
#define PERSIST_KEY_COUNT        100
#define PERSIST_KEY_QUICK_TOGGLE 101
#define PERSIST_KEY_AUTO_CLOSE   102
#define PERSIST_KEY_LIGHT_BASE   200   // + i

bool s_cfg_quick_toggle = true;    // default ON  (matches Clay defaultValue)
bool s_cfg_auto_close   = false;   // default OFF (matches Clay defaultValue)

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

static Window *s_list_window;
static MenuLayer *s_menu;
static StatusBarLayer *s_status;

// --- Auto-close (close the app once a toggle's cloud command is confirmed) ---
static int s_close_pending_index = -1;     // -1 = no close pending
static AppTimer *s_close_timer = NULL;
static Window *s_closing_window = NULL;
static TextLayer *s_closing_text = NULL;
static void do_close(void);
static void cancel_auto_close(void);

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
  if (s_state != ST_READY) return 1;
  return s_light_count == 0 ? 1 : s_light_count;
}

static void menu_draw_row(GContext *g, const Layer *cell, MenuIndex *ci, void *ctx) {
  if (s_error[0]) { menu_cell_basic_draw(g, cell, "Error", s_error, NULL); return; }
  if (s_state == ST_LOADING) { menu_cell_basic_draw(g, cell, "Tuya Lights", "Loading…", NULL); return; }
  if (s_state == ST_NOCONFIG) { menu_cell_basic_draw(g, cell, "Tuya Lights", "Configure on phone…", NULL); return; }
  if (s_light_count == 0) { menu_cell_basic_draw(g, cell, "No lights found", NULL, NULL); return; }
  int li = (ci->row < s_light_count) ? s_order[ci->row] : ci->row;
  Light *l = &s_lights[li];
  static char sub[24];
  if (!l->online) snprintf(sub, sizeof(sub), "Offline");
  else if (l->on) snprintf(sub, sizeof(sub), "On · %d%%", l->bright);
  else snprintf(sub, sizeof(sub), "Off");
  menu_cell_basic_draw(g, cell, l->name, sub, NULL);
}

static void menu_select(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  if (ci->row >= s_light_count) return;
  if (!s_cfg_quick_toggle) { control_window_push(s_order[ci->row]); return; }   // classic behaviour
  int row = s_order[ci->row];
  s_lights[row].on = !s_lights[row].on;   // optimistic; PKJS pushes authoritative state back
  send_command(row, ACT_TOGGLE);
  menu_layer_reload_data(s_menu);
  if (s_cfg_auto_close) begin_auto_close(row);
}

static void menu_select_long(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  if (ci->row >= s_light_count) return;
  control_window_push(s_order[ci->row]);   // long press always opens the control window
}

static void list_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  GRect b = layer_get_bounds(root);
  s_status = status_bar_layer_create();
  s_menu = menu_layer_create(GRect(0, STATUS_BAR_LAYER_HEIGHT, b.size.w, b.size.h - STATUS_BAR_LAYER_HEIGHT));
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks){
    .get_num_rows = menu_num_rows, .draw_row = menu_draw_row,
    .select_click = menu_select, .select_long_click = menu_select_long });
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
    cancel_auto_close();
    strncpy(s_error, t->value->cstring, sizeof(s_error) - 1);
    s_error[sizeof(s_error) - 1] = '\0';
    list_window_reload(); return;
  }
  if ((t = dict_find(it, MESSAGE_KEY_Ready))) {
    s_state = t->value->int32 ? ST_READY : ST_NOCONFIG;
    s_error[0] = '\0';
  }
  Tuple *qt = dict_find(it, MESSAGE_KEY_CfgQuickToggle);
  if (qt) { s_cfg_quick_toggle = qt->value->int32 ? true : false; persist_write_bool(PERSIST_KEY_QUICK_TOGGLE, s_cfg_quick_toggle); }
  Tuple *ac = dict_find(it, MESSAGE_KEY_CfgAutoClose);
  if (ac) { s_cfg_auto_close = ac->value->int32 ? true : false; persist_write_bool(PERSIST_KEY_AUTO_CLOSE, s_cfg_auto_close); }
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
  rebuild_order();
  list_window_reload();
  if (idx_t) control_window_refresh(idx_t->value->int32);
  Tuple *cd = dict_find(it, MESSAGE_KEY_CmdDone);
  if (cd && s_close_pending_index >= 0 && cd->value->int32 == s_close_pending_index) {
    do_close();
  }
}

static void outbox_failed(DictionaryIterator *it, AppMessageResult reason, void *ctx) {
  // Required on real hardware: the phone ACKs outbound messages and the SDK
  // dispatches the result callback. A missing handler hard-faults (CLAUDE.md).
}

static void outbox_sent(DictionaryIterator *it, void *ctx) {}

static void load_persisted(void) {
  if (persist_exists(PERSIST_KEY_QUICK_TOGGLE)) s_cfg_quick_toggle = persist_read_bool(PERSIST_KEY_QUICK_TOGGLE);
  if (persist_exists(PERSIST_KEY_AUTO_CLOSE))   s_cfg_auto_close   = persist_read_bool(PERSIST_KEY_AUTO_CLOSE);
  if (!persist_exists(PERSIST_KEY_COUNT)) return;
  int n = persist_read_int(PERSIST_KEY_COUNT);
  if (n > MAX_LIGHTS) n = MAX_LIGHTS;
  int valid = 0;
  for (int i = 0; i < n; i++) {
    if (persist_exists(PERSIST_KEY_LIGHT_BASE + i) &&
        persist_get_size(PERSIST_KEY_LIGHT_BASE + i) == (int)sizeof(Light)) {
      persist_read_data(PERSIST_KEY_LIGHT_BASE + i, &s_lights[i], sizeof(Light));
      valid++;
    } else break;
  }
  s_light_count = valid;
  if (valid > 0) s_state = ST_READY;   // cached list is usable immediately
}

static void save_persisted(void) {
  persist_write_bool(PERSIST_KEY_QUICK_TOGGLE, s_cfg_quick_toggle);
  persist_write_bool(PERSIST_KEY_AUTO_CLOSE, s_cfg_auto_close);
  persist_write_int(PERSIST_KEY_COUNT, s_light_count);
  for (int i = 0; i < s_light_count && i < MAX_LIGHTS; i++) {
    persist_write_data(PERSIST_KEY_LIGHT_BASE + i, &s_lights[i], sizeof(Light));
  }
}

static void closing_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  GRect b = layer_get_bounds(root);
  s_closing_text = text_layer_create(GRect(4, (b.size.h - 30) / 2, b.size.w - 8, 30));
  text_layer_set_font(s_closing_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_closing_text, GTextAlignmentCenter);
  text_layer_set_text(s_closing_text, "Switching…");
  layer_add_child(root, text_layer_get_layer(s_closing_text));
}
static void closing_unload(Window *w) { text_layer_destroy(s_closing_text); s_closing_text = NULL; }

// Swallow Back (and leave Up/Down/Select unsubscribed) while "Switching…" is shown:
// the brief closing state can only end via CmdDone or the timeout, so it can't be
// aborted into a half-state or double-toggled.
static void closing_noop(ClickRecognizerRef r, void *ctx) {}
static void closing_click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_BACK, closing_noop);
}

static void close_timeout(void *ctx) { s_close_timer = NULL; do_close(); }

void begin_auto_close(int index) {
  if (s_close_timer) { app_timer_cancel(s_close_timer); s_close_timer = NULL; }  // never orphan a prior timer
  s_close_pending_index = index;
  if (!s_closing_window) {
    s_closing_window = window_create();
    window_set_window_handlers(s_closing_window, (WindowHandlers){ .load = closing_load, .unload = closing_unload });
    window_set_click_config_provider(s_closing_window, closing_click_config);
  }
  if (window_stack_get_top_window() != s_closing_window) window_stack_push(s_closing_window, true);
  s_close_timer = app_timer_register(4000, close_timeout, NULL);   // fallback so it never hangs
}

static void cancel_auto_close(void) {
  if (s_close_pending_index < 0) return;
  s_close_pending_index = -1;
  if (s_close_timer) { app_timer_cancel(s_close_timer); s_close_timer = NULL; }
  if (s_closing_window) window_stack_remove(s_closing_window, true);   // no-op if not stacked
}

static void do_close(void) {
  if (s_close_timer) { app_timer_cancel(s_close_timer); s_close_timer = NULL; }
  s_close_pending_index = -1;
  // One-click action done: exit to the watchface, not back to the launcher/menu.
  exit_reason_set(APP_EXIT_ACTION_PERFORMED_SUCCESSFULLY);
  window_stack_pop_all(true);   // exits the app -> deinit() persists state
  s_closing_window = NULL;      // drop our handle (app is exiting); avoids any double-destroy
}

static void init(void) {
  load_persisted();
  app_message_register_inbox_received(inbox_received);
  app_message_register_outbox_sent(outbox_sent);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(512, 256);

  s_list_window = window_create();
  window_set_window_handlers(s_list_window, (WindowHandlers){ .load = list_load, .unload = list_unload });
  window_stack_push(s_list_window, true);
}

static void deinit(void) {
  save_persisted();
  if (s_close_timer) app_timer_cancel(s_close_timer);
  control_window_deinit();
  if (s_closing_window) window_destroy(s_closing_window);
  window_destroy(s_list_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
