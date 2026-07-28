#pragma once
#include <stdbool.h>

// Pure load-epoch reconciliation for the watch's row list — host-testable (no pebble.h).
//
// Every full push from PKJS is one epoch: `ListCount` then one message per row, each
// carrying the stable `RowId` (matched to an existing storage slot) and `RowIndex` (the
// row's position in the user's ordered config selection). Rows update IN PLACE during
// the epoch so the displayed list can't reflow under the finger; when the batch is
// complete the storage array is reconciled with the phone in ONE step:
//   * rows not seen in this epoch are dropped (deselected / removed from the account),
//   * survivors are reordered to the config order the phone sent.
//
// row_index[i] / seen[i] describe storage slot i (seen = row arrived in this epoch).
// out[k] receives the OLD slot index that becomes new slot k; returns the new count.
// Rows with row_index < 0 sort last in arrival order (defensive: PKJS always sends it).
// The sort is stable, so equal RowIndex values keep arrival order.
int row_order_reconcile(const int *row_index, const int *seen, int n, int *out);

// true if `out` (of length n_new) is the identity permutation of an n_old-row list,
// i.e. nothing was pruned and nothing moved — the caller can then skip the reorder
// entirely and leave the current display order (incl. an MRU sort) untouched.
bool row_order_is_identity(const int *out, int n_new, int n_old);
