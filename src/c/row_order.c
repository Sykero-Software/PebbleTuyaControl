#include "row_order.h"

int row_order_reconcile(const int *row_index, const int *seen, int n, int *out) {
  if (!row_index || !seen || !out || n <= 0) return 0;
  int w = 0;
  for (int i = 0; i < n; i++) {          // collect survivors in arrival order first
    if (seen[i]) out[w++] = i;
  }
  // Stable insertion sort by RowIndex (n <= 12), with "no RowIndex" (< 0) sorting last.
  for (int i = 1; i < w; i++) {
    int cur = out[i], j = i - 1;
    int rc = row_index[cur];
    while (j >= 0) {
      int rp = row_index[out[j]];
      bool cur_before = (rc < 0) ? false        // unknown index never climbs above a known one
                        : (rp < 0) ? true       // ...but a known index climbs above an unknown
                        : (rc < rp);            // strict: equal indices keep arrival order
      if (!cur_before) break;
      out[j + 1] = out[j];
      j--;
    }
    out[j + 1] = cur;
  }
  return w;
}

bool row_order_is_identity(const int *out, int n_new, int n_old) {
  if (!out || n_new != n_old) return false;
  for (int i = 0; i < n_new; i++) {
    if (out[i] != i) return false;
  }
  return true;
}
