// Host test for the pure load-epoch reconciliation (config order + pruning).
// Build/run: gcc -I src/c tests/test_row_order.c src/c/row_order.c -o /tmp/t && /tmp/t
#include "row_order.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
  int out[16];

  // --- unchanged order: identity permutation, nothing pruned ---
  {
    int rix[3]  = { 0, 1, 2 };
    int seen[3] = { 1, 1, 1 };
    assert(row_order_reconcile(rix, seen, 3, out) == 3);
    assert(out[0] == 0 && out[1] == 1 && out[2] == 2);
    assert(row_order_is_identity(out, 3, 3) == true);
  }

  // --- the phone reordered the selection: storage follows the new RowIndex order ---
  // Slots 0,1,2 now carry RowIndex 2,0,1 -> new order is old 1,2,0.
  {
    int rix[3]  = { 2, 0, 1 };
    int seen[3] = { 1, 1, 1 };
    assert(row_order_reconcile(rix, seen, 3, out) == 3);
    assert(out[0] == 1 && out[1] == 2 && out[2] == 0);
    assert(row_order_is_identity(out, 3, 3) == false);
  }

  // --- a full reversal ---
  {
    int rix[4]  = { 3, 2, 1, 0 };
    int seen[4] = { 1, 1, 1, 1 };
    assert(row_order_reconcile(rix, seen, 4, out) == 4);
    assert(out[0] == 3 && out[1] == 2 && out[2] == 1 && out[3] == 0);
  }

  // --- a deselected/removed row is pruned, the rest keep the config order ---
  {
    int rix[4]  = { 1, -1, 0, 2 };   // slot 1 was not in this epoch
    int seen[4] = { 1,  0, 1, 1 };
    assert(row_order_reconcile(rix, seen, 4, out) == 3);
    assert(out[0] == 2 && out[1] == 0 && out[2] == 3);
    assert(row_order_is_identity(out, 3, 4) == false);   // count shrank -> not identity
  }

  // --- a newly appended row (arrived last, highest RowIndex) lands at the bottom ---
  {
    int rix[3]  = { 0, 1, 2 };
    int seen[3] = { 1, 1, 1 };
    assert(row_order_reconcile(rix, seen, 3, out) == 3);
    assert(out[2] == 2);
  }

  // --- everything deselected (ListCount:0) -> empty list ---
  {
    int rix[2]  = { -1, -1 };
    int seen[2] = { 0, 0 };
    assert(row_order_reconcile(rix, seen, 2, out) == 0);
    assert(row_order_is_identity(out, 0, 2) == false);
  }

  // --- rows without a RowIndex sort last, keeping arrival order (defensive) ---
  {
    int rix[4]  = { -1, 1, -1, 0 };
    int seen[4] = { 1, 1, 1, 1 };
    assert(row_order_reconcile(rix, seen, 4, out) == 4);
    assert(out[0] == 3 && out[1] == 1 && out[2] == 0 && out[3] == 2);
  }

  // --- duplicate RowIndex values keep arrival order (stable sort) ---
  {
    int rix[3]  = { 1, 0, 1 };
    int seen[3] = { 1, 1, 1 };
    assert(row_order_reconcile(rix, seen, 3, out) == 3);
    assert(out[0] == 1 && out[1] == 0 && out[2] == 2);
  }

  // --- n is clamped to the row buffer, negative/zero n is safe ---
  {
    int rix[1] = { 0 }, seen[1] = { 1 };
    assert(row_order_reconcile(rix, seen, 0, out) == 0);
    assert(row_order_reconcile(rix, seen, -3, out) == 0);
    assert(row_order_reconcile(NULL, seen, 1, out) == 0);
    assert(row_order_reconcile(rix, NULL, 1, out) == 0);
  }

  printf("row_order: all tests passed\n");
  return 0;
}
