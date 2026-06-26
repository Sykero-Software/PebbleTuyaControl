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
#define PERSIST_KEY_MRU_ENABLED  103
#define PERSIST_KEY_MRU_COUNT    104
#define PERSIST_KEY_MRU_BASE     300   // + i, one name string per entry

bool s_cfg_quick_toggle = true;    // default ON  (matches Clay defaultValue)
bool s_cfg_auto_close   = false;   // default OFF (matches Clay defaultValue)

// --- MRU (most-recently-used) ordering --------------------------------------
// Recency identity is the light NAME (see spec). s_mru holds names most-recent
// first; s_order maps a display row to an index into s_lights[].
bool s_cfg_mru = true;                       // default ON (matches Clay defaultValue)
static char s_mru[MAX_LIGHTS][NAME_LEN];
static int  s_mru_count = 0;
static int  s_order[MAX_LIGHTS];

// Load-batch reconciliation (D3): each full push from PKJS is one epoch. Rows seen in
// the current epoch survive; rows absent (device removed) are pruned when the batch
// completes (received == ListCount). Parallel array, NOT a Light field — keeps
// sizeof(Light) and the persist format unchanged.
static int s_load_epoch = 0;
static int s_seen_epoch[MAX_LIGHTS];
static int s_received_in_epoch = 0;
static int s_expected_count = 0;

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
static Layer *s_sync_layer = NULL;   // small "syncing" dot over the status strip
static bool  s_syncing = false;      // set from the phone's Syncing key

// --- Auto-close (close the app once a toggle's cloud command is confirmed) ---
static char s_close_pending_id[ID_LEN] = "";   // "" = no close pending; matched against CmdDone
static Light s_close_snapshot;                  // pre-command state, restored if unconfirmed
static AppTimer *s_close_timer = NULL;
static Window *s_closing_window = NULL;
static TextLayer *s_closing_text = NULL;
static void do_close(void);
static void cancel_auto_close(void);

// --- Stable-id lookup ---
// The list (both here and the phone's slots) can be reordered asynchronously
// (online-first sort, device add/remove, MRU). So commands are addressed by the
// stable Tuya device id, never by list position — resolve the current index here.
int find_light_by_id(const char *id) {
  if (!id || !id[0]) return -1;
  for (int i = 0; i < s_light_count && i < MAX_LIGHTS; i++) {
    if (strcmp(s_lights[i].id, id) == 0) return i;
  }
  return -1;
}

// --- AppMessage send ---
void send_command(int index, int action, int desired_on) {
  if (index < 0 || index >= s_light_count) return;
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) return;
  dict_write_cstring(it, MESSAGE_KEY_CmdLightId, s_lights[index].id);   // stable id, not position
  dict_write_int32(it, MESSAGE_KEY_CmdAction, action);
  if (desired_on >= 0) dict_write_int32(it, MESSAGE_KEY_CmdDesiredOn, desired_on);
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
  if (!l->online) {
    snprintf(sub, sizeof(sub), "Offline");
    graphics_context_set_text_color(g, GColorLightGray);   // disabled look
  } else if (l->on) snprintf(sub, sizeof(sub), "On · %d%%", l->bright);
  else snprintf(sub, sizeof(sub), "Off");
  menu_cell_basic_draw(g, cell, l->name, sub, NULL);
}

static void menu_select(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  if (ci->row >= s_light_count) return;
  int row = s_order[ci->row];
  if (!s_lights[row].online) return;   // offline = disabled, silent no-op
  if (!s_cfg_quick_toggle) { control_window_push(row); return; }   // classic behaviour
  Light prev = s_lights[row];             // confirmed state, restored if the command is unconfirmed
  int desired_on = s_lights[row].on ? 0 : 1;   // from the state the watch DISPLAYED
  s_lights[row].on = desired_on;          // optimistic; PKJS pushes authoritative state back
  send_command(row, ACT_TOGGLE, desired_on);
  mark_used(s_lights[row].name);
  rebuild_order();
  menu_layer_reload_data(s_menu);
  if (s_cfg_auto_close) begin_auto_close(row, &prev);
}

static void menu_select_long(MenuLayer *m, MenuIndex *ci, void *ctx) {
  if (s_state != ST_READY || s_light_count == 0 || s_error[0]) return;
  if (ci->row >= s_light_count) return;
  int row = s_order[ci->row];
  if (!s_lights[row].online) return;   // offline = disabled, cannot open control window
  control_window_push(row);
}

static void sync_update_proc(Layer *layer, GContext *ctx) {
  if (!s_syncing) return;
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorDarkGray);
  graphics_fill_circle(ctx, GPoint(b.size.w / 2, b.size.h / 2), 4);
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
  s_sync_layer = layer_create(GRect(b.size.w - 16, 2, 12, 12));
  layer_set_update_proc(s_sync_layer, sync_update_proc);
  layer_add_child(root, s_sync_layer);
}

static void list_unload(Window *w) {
  menu_layer_destroy(s_menu);
  status_bar_layer_destroy(s_status);
  if (s_sync_layer) { layer_destroy(s_sync_layer); s_sync_layer = NULL; }
}

void list_window_reload(void) {
  if (s_menu) menu_layer_reload_data(s_menu);
}

void tuya_mark_used(int light_index) {
  if (light_index < 0 || light_index >= s_light_count) return;
  mark_used(s_lights[light_index].name);
  rebuild_order();
  list_window_reload();
}

// Drop lights not seen in the current load epoch (removed from the account), preserving
// the DISPLAY order of survivors. Buffers are static: the event loop is single-threaded,
// and big stack locals overflow the ~2 KB Pebble app stack (CLAUDE.md).
static void prune_stale_lights(void) {
  static Light tmp[MAX_LIGHTS];
  static int seen_tmp[MAX_LIGHTS];
  int w = 0;
  for (int d = 0; d < s_light_count; d++) {       // iterate in DISPLAY order
    int si = s_order[d];
    if (si >= 0 && si < s_light_count && s_seen_epoch[si] == s_load_epoch) {
      tmp[w] = s_lights[si];
      seen_tmp[w] = s_seen_epoch[si];
      w++;
    }
  }
  if (w == s_light_count) return;                 // nothing removed
  for (int i = 0; i < w; i++) { s_lights[i] = tmp[i]; s_seen_epoch[i] = seen_tmp[i]; }
  s_light_count = w;
  for (int i = 0; i < w; i++) s_order[i] = i;      // storage now == display order
}

// --- AppMessage receive ---
static void inbox_received(DictionaryIterator *it, void *ctx) {
#ifdef SCREENSHOT_FIXTURES
  return;  // keep the seeded demo list; ignore PKJS state pushes (e.g. NOCONFIG) on the emulator
#endif
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
  Tuple *sy = dict_find(it, MESSAGE_KEY_Syncing);
  if (sy) { s_syncing = sy->value->int32 ? true : false; if (s_sync_layer) layer_mark_dirty(s_sync_layer); }
  if ((t = dict_find(it, MESSAGE_KEY_ListCount))) {
    s_expected_count = t->value->int32;
    if (s_expected_count > MAX_LIGHTS) s_expected_count = MAX_LIGHTS;
    s_load_epoch++;                 // a new full push begins
    s_received_in_epoch = 0;
  }
  Tuple *qt = dict_find(it, MESSAGE_KEY_CfgQuickToggle);
  if (qt) { s_cfg_quick_toggle = qt->value->int32 ? true : false; persist_write_bool(PERSIST_KEY_QUICK_TOGGLE, s_cfg_quick_toggle); }
  Tuple *ac = dict_find(it, MESSAGE_KEY_CfgAutoClose);
  if (ac) { s_cfg_auto_close = ac->value->int32 ? true : false; persist_write_bool(PERSIST_KEY_AUTO_CLOSE, s_cfg_auto_close); }
  Tuple *mru = dict_find(it, MESSAGE_KEY_CfgMru);
  if (mru) { s_cfg_mru = mru->value->int32 ? true : false; persist_write_bool(PERSIST_KEY_MRU_ENABLED, s_cfg_mru); }
  Tuple *rid_t = dict_find(it, MESSAGE_KEY_RowId);
  const char *rid = rid_t ? rid_t->value->cstring : NULL;
  if (rid && rid[0]) {
    int i = find_light_by_id(rid);                       // update existing row IN PLACE
    if (i < 0 && s_light_count < MAX_LIGHTS) {            // or append a genuinely new light
      i = s_light_count++;
      strncpy(s_lights[i].id, rid, ID_LEN - 1); s_lights[i].id[ID_LEN - 1] = '\0';
      s_order[i] = i;                                     // new row at the bottom; existing rows don't reflow
    }
    if (i >= 0) {
      Tuple *n = dict_find(it, MESSAGE_KEY_RowName);
      if (n) { strncpy(s_lights[i].name, n->value->cstring, NAME_LEN - 1); s_lights[i].name[NAME_LEN - 1] = '\0'; }
      Tuple *on = dict_find(it, MESSAGE_KEY_RowOn);     if (on) s_lights[i].on = on->value->int32;
      Tuple *br = dict_find(it, MESSAGE_KEY_RowBright); if (br) s_lights[i].bright = br->value->int32;
      Tuple *tp = dict_find(it, MESSAGE_KEY_RowTemp);   if (tp) s_lights[i].temp = tp->value->int32;
      Tuple *ol = dict_find(it, MESSAGE_KEY_RowOnline); if (ol) s_lights[i].online = ol->value->int32;
      s_seen_epoch[i] = s_load_epoch;
      s_received_in_epoch++;
    }
  }
  // D2: display order is FROZEN during loads — NO rebuild_order() here. Values update
  // in place (D1); order is recomputed only at launch and after a user action.
  if (s_expected_count > 0 && s_received_in_epoch >= s_expected_count) {
    prune_stale_lights();
    s_expected_count = 0;           // batch consumed; later stray rows (e.g. CmdDone) don't re-prune
  }
  list_window_reload();
  if (rid) control_window_refresh(rid);
  Tuple *cd = dict_find(it, MESSAGE_KEY_CmdDone);
  if (cd && s_close_pending_id[0] && strcmp(cd->value->cstring, s_close_pending_id) == 0) {
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
  if (persist_exists(PERSIST_KEY_MRU_ENABLED))  s_cfg_mru          = persist_read_bool(PERSIST_KEY_MRU_ENABLED);
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
  rebuild_order();
}

static void save_persisted(void) {
  persist_write_bool(PERSIST_KEY_QUICK_TOGGLE, s_cfg_quick_toggle);
  persist_write_bool(PERSIST_KEY_AUTO_CLOSE, s_cfg_auto_close);
  persist_write_int(PERSIST_KEY_COUNT, s_light_count);
  for (int i = 0; i < s_light_count && i < MAX_LIGHTS; i++) {
    persist_write_data(PERSIST_KEY_LIGHT_BASE + i, &s_lights[i], sizeof(Light));
  }
  persist_write_bool(PERSIST_KEY_MRU_ENABLED, s_cfg_mru);
  persist_write_int(PERSIST_KEY_MRU_COUNT, s_mru_count);
  for (int i = 0; i < s_mru_count && i < MAX_LIGHTS; i++) {
    persist_write_string(PERSIST_KEY_MRU_BASE + i, s_mru[i]);
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

// No confirmation arrived in time. The command likely never reached the cloud
// (phone unreachable / hung), so DON'T exit as if it succeeded: revert the optimistic
// change to the snapshot and surface an error, leaving the app open so the watch never
// reports a state the cloud never received.
static void close_timeout(void *ctx) {
  s_close_timer = NULL;
  int i = find_light_by_id(s_close_pending_id);
  if (i >= 0) s_lights[i] = s_close_snapshot;   // restore last-known (confirmed) state
  s_close_pending_id[0] = '\0';
  if (s_closing_window) window_stack_remove(s_closing_window, true);
  strncpy(s_error, "No response from phone", sizeof(s_error) - 1);
  s_error[sizeof(s_error) - 1] = '\0';
  rebuild_order();
  list_window_reload();
}

void begin_auto_close(int index, const Light *prev) {
  if (s_close_timer) { app_timer_cancel(s_close_timer); s_close_timer = NULL; }  // never orphan a prior timer
  if (index >= 0 && index < s_light_count) {
    strncpy(s_close_pending_id, s_lights[index].id, ID_LEN - 1);   // match CmdDone by stable id
    s_close_pending_id[ID_LEN - 1] = '\0';
    if (prev) s_close_snapshot = *prev;                            // for revert on timeout
  }
  if (!s_closing_window) {
    s_closing_window = window_create();
    window_set_window_handlers(s_closing_window, (WindowHandlers){ .load = closing_load, .unload = closing_unload });
    window_set_click_config_provider(s_closing_window, closing_click_config);
  }
  if (window_stack_get_top_window() != s_closing_window) window_stack_push(s_closing_window, true);
  s_close_timer = app_timer_register(8000, close_timeout, NULL);   // revert+error if unconfirmed by then
}

static void cancel_auto_close(void) {
  if (!s_close_pending_id[0]) return;
  s_close_pending_id[0] = '\0';
  if (s_close_timer) { app_timer_cancel(s_close_timer); s_close_timer = NULL; }
  if (s_closing_window) window_stack_remove(s_closing_window, true);   // no-op if not stacked
}

static void do_close(void) {
  if (s_close_timer) { app_timer_cancel(s_close_timer); s_close_timer = NULL; }
  s_close_pending_id[0] = '\0';
  // One-click action done: exit to the watchface, not back to the launcher/menu.
  exit_reason_set(APP_EXIT_ACTION_PERFORMED_SUCCESSFULLY);
  window_stack_pop_all(true);   // exits the app -> deinit() persists state
  s_closing_window = NULL;      // drop our handle (app is exiting); avoids any double-destroy
}

static void init(void) {
  load_persisted();
#ifdef SCREENSHOT_FIXTURES
  // Deterministic demo light list for appstore screenshots (no phone/cloud needed).
  // Compiled out of normal builds; enabled via the wscript SCREENSHOT_FIXTURES define.
  s_light_count = 4;
  strncpy(s_lights[0].name, "Living room", NAME_LEN - 1); s_lights[0].on = 1; s_lights[0].bright = 80;  s_lights[0].temp = 50; s_lights[0].online = 1;
  strncpy(s_lights[1].name, "Kitchen",     NAME_LEN - 1); s_lights[1].on = 1; s_lights[1].bright = 100; s_lights[1].temp = -1; s_lights[1].online = 1;
  strncpy(s_lights[2].name, "Bedroom",     NAME_LEN - 1); s_lights[2].on = 0; s_lights[2].bright = 40;  s_lights[2].temp = 30; s_lights[2].online = 1;
  strncpy(s_lights[3].name, "Garage",      NAME_LEN - 1); s_lights[3].on = 0; s_lights[3].bright = 0;   s_lights[3].temp = -1; s_lights[3].online = 0;
  s_state = ST_READY;
  s_error[0] = '\0';
  rebuild_order();
#endif
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
