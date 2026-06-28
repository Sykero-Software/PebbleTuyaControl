const L = require('../src/pkjs/tuya-lights');

describe('detectCaps', () => {
  test('reads v2 codes and ranges from specification', () => {
    const spec = { functions: [
      { code: 'switch_led', type: 'Boolean' },
      { code: 'bright_value_v2', type: 'Integer', values: '{"min":10,"max":1000}' },
      { code: 'temp_value_v2', type: 'Integer', values: '{"min":0,"max":1000}' }
    ] };
    expect(L.detectCaps(spec)).toEqual({
      switchCode: 'switch_led',
      brightCode: 'bright_value_v2', brightMin: 10, brightMax: 1000,
      tempCode: 'temp_value_v2', tempMin: 0, tempMax: 1000
    });
  });

  test('falls back to legacy codes', () => {
    const spec = { functions: [
      { code: 'switch_led', type: 'Boolean' },
      { code: 'bright_value', type: 'Integer', values: '{"min":25,"max":255}' }
    ] };
    const caps = L.detectCaps(spec);
    expect(caps.brightCode).toBe('bright_value');
    expect(caps.brightMin).toBe(25);
    expect(caps.tempCode).toBeNull();
  });
});

describe('normalisePercent / scaleToRaw', () => {
  test('raw->percent', () => {
    expect(L.rawToPercent(505, 10, 1000)).toBe(50);
    expect(L.rawToPercent(10, 10, 1000)).toBe(0);
    expect(L.rawToPercent(1000, 10, 1000)).toBe(100);
  });
  test('percent->raw clamps', () => {
    expect(L.percentToRaw(0, 10, 1000)).toBe(10);
    expect(L.percentToRaw(100, 10, 1000)).toBe(1000);
    expect(L.percentToRaw(150, 10, 1000)).toBe(1000);
    expect(L.percentToRaw(-5, 10, 1000)).toBe(10);
  });
});

describe('parseStatus', () => {
  test('maps status array to normalised state', () => {
    const caps = { switchCode: 'switch_led', brightCode: 'bright_value_v2', brightMin: 10, brightMax: 1000,
                   tempCode: 'temp_value_v2', tempMin: 0, tempMax: 1000 };
    const status = [
      { code: 'switch_led', value: true },
      { code: 'bright_value_v2', value: 1000 },
      { code: 'temp_value_v2', value: 0 }
    ];
    expect(L.parseStatus(status, caps)).toEqual({ on: 1, bright: 100, temp: 0 });
  });
  test('temp -1 when unsupported', () => {
    const caps = { switchCode: 'switch_led', brightCode: 'bright_value', brightMin: 25, brightMax: 255, tempCode: null };
    expect(L.parseStatus([{ code: 'switch_led', value: false }], caps)).toEqual({ on: 0, bright: 0, temp: -1 });
  });
  test('temp -1 when code declared but value missing from status', () => {
    const caps = { switchCode: 'switch_led', brightCode: 'bright_value_v2', brightMin: 10, brightMax: 1000,
                   tempCode: 'temp_value_v2', tempMin: 0, tempMax: 1000 };
    expect(L.parseStatus([{ code: 'switch_led', value: true }], caps)).toEqual({ on: 1, bright: 0, temp: -1 });
  });
});

describe('actionToCommands', () => {
  const caps = { switchCode: 'switch_led', brightCode: 'bright_value_v2', brightMin: 10, brightMax: 1000,
                 tempCode: 'temp_value_v2', tempMin: 0, tempMax: 1000 };
  const ACT = L.ACTIONS;
  test('TOGGLE inverts power', () => {
    expect(L.actionToCommands(ACT.TOGGLE, { on: 1, bright: 50, temp: 50 }, caps))
      .toEqual([{ code: 'switch_led', value: false }]);
  });
  test('BRIGHT_UP raises by 20% and sets raw', () => {
    expect(L.actionToCommands(ACT.BRIGHT_UP, { on: 1, bright: 50, temp: 50 }, caps))
      .toEqual([{ code: 'bright_value_v2', value: L.percentToRaw(70, 10, 1000) }]);
  });
  test('TEMP_DOWN lowers by 20% and sets raw', () => {
    expect(L.actionToCommands(ACT.TEMP_DOWN, { on: 1, bright: 50, temp: 50 }, caps))
      .toEqual([{ code: 'temp_value_v2', value: L.percentToRaw(30, 0, 1000) }]);
  });
  test('TEMP_UP on unsupported device returns []', () => {
    const noTemp = Object.assign({}, caps, { tempCode: null });
    expect(L.actionToCommands(ACT.TEMP_UP, { on: 1, bright: 50, temp: -1 }, noTemp)).toEqual([]);
  });
});

describe('applyActionToState', () => {
  const caps = { switchCode: 'switch_led', brightCode: 'bright_value_v2', brightMin: 10, brightMax: 1000,
                 tempCode: 'temp_value_v2', tempMin: 0, tempMax: 1000 };
  const ACT = L.ACTIONS;
  test('TOGGLE flips on (off -> on)', () => {
    expect(L.applyActionToState(ACT.TOGGLE, { on: 0, bright: 50, temp: 50 }, caps))
      .toEqual({ on: 1, bright: 50, temp: 50 });
  });
  test('TOGGLE flips on (on -> off)', () => {
    expect(L.applyActionToState(ACT.TOGGLE, { on: 1, bright: 50, temp: 50 }, caps))
      .toEqual({ on: 0, bright: 50, temp: 50 });
  });
  test('BRIGHT_UP raises by step and clamps at 100', () => {
    expect(L.applyActionToState(ACT.BRIGHT_UP, { on: 1, bright: 90, temp: 50 }, caps))
      .toEqual({ on: 1, bright: 100, temp: 50 });
  });
  test('TEMP_DOWN lowers by step and clamps at 0', () => {
    expect(L.applyActionToState(ACT.TEMP_DOWN, { on: 1, bright: 50, temp: 10 }, caps))
      .toEqual({ on: 1, bright: 50, temp: 0 });
  });
  test('TEMP_UP is a no-op when temp unsupported', () => {
    const noTemp = Object.assign({}, caps, { tempCode: null });
    expect(L.applyActionToState(ACT.TEMP_UP, { on: 1, bright: 50, temp: -1 }, noTemp))
      .toEqual({ on: 1, bright: 50, temp: -1 });
  });
});

describe('cfgToInts', () => {
  test('defaults: quick-toggle on, auto-close off, mru on, idle-exit 15 when keys absent', () => {
    expect(L.cfgToInts({})).toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0, CfgMru: 1, CfgIdleExitSec: 15 });
    expect(L.cfgToInts(undefined)).toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0, CfgMru: 1, CfgIdleExitSec: 15 });
  });
  test('maps booleans to ints', () => {
    expect(L.cfgToInts({ CfgQuickToggle: false, CfgAutoClose: true, CfgMru: false }))
      .toEqual({ CfgQuickToggle: 0, CfgAutoClose: 1, CfgMru: 0, CfgIdleExitSec: 15 });
    expect(L.cfgToInts({ CfgQuickToggle: true, CfgAutoClose: false, CfgMru: true }))
      .toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0, CfgMru: 1, CfgIdleExitSec: 15 });
  });
  test('idle-exit: select string parses to int; "0" (Off) round-trips to 0', () => {
    expect(L.cfgToInts({ CfgIdleExitSec: '30' }).CfgIdleExitSec).toBe(30);
    expect(L.cfgToInts({ CfgIdleExitSec: '0' }).CfgIdleExitSec).toBe(0);
    expect(L.cfgToInts({ CfgIdleExitSec: 60 }).CfgIdleExitSec).toBe(60);
  });
});

describe('resolveSlot', () => {
  test('finds the slot by stable device id, not by position', () => {
    const slots = [
      { index: 0, id: 'A', name: 'A' },
      { index: 1, id: 'B', name: 'B' }
    ];
    expect(L.resolveSlot('B', slots).index).toBe(1);
    expect(L.resolveSlot('A', slots).id).toBe('A');
  });
  test('returns null for an unknown id (device removed)', () => {
    expect(L.resolveSlot('gone', [{ index: 0, id: 'A' }])).toBeNull();
  });
  test('returns null for an empty/undefined id', () => {
    expect(L.resolveSlot('', [{ index: 0, id: 'A' }])).toBeNull();
    expect(L.resolveSlot(undefined, [{ index: 0, id: 'A' }])).toBeNull();
  });
  test('reorder-safe: the addressed device is hit even after slots reorder', () => {
    // The user addressed "living" while it sat at index 0; a poll then reordered
    // slots (online-first) so index 0 is now a different device. Resolving by id
    // must still target "living", never whatever now occupies index 0.
    const reordered = [
      { index: 0, id: 'kitchen', name: 'Kitchen' },
      { index: 1, id: 'living', name: 'Living' }
    ];
    expect(L.resolveSlot('living', reordered).id).toBe('living');
    expect(L.resolveSlot('living', reordered).index).toBe(1);
  });
});

describe('commandDeliverable', () => {
  const slots = [{ index: 0, id: 'A' }];
  test('false when id not found in slots', () => {
    expect(L.commandDeliverable('A', [], {}, {})).toBe(false);
    expect(L.commandDeliverable('gone', slots, { A: { switchCode: 's' } }, { A: { on: 0 } })).toBe(false);
  });
  test('false when caps or state missing', () => {
    expect(L.commandDeliverable('A', slots, {}, { A: { on: 0 } })).toBe(false);
    expect(L.commandDeliverable('A', slots, { A: { switchCode: 's' } }, {})).toBe(false);
  });
  test('true when slot, caps and state are present', () => {
    expect(L.commandDeliverable('A', slots, { A: { switchCode: 's' } }, { A: { on: 0 } })).toBe(true);
  });
});

describe('packModel / unpackModel (localStorage cache)', () => {
  const slots = [{ index: 0, id: 'a', name: 'A', online: 1 }];
  const caps = { a: { switchCode: 'switch_led' } };
  const state = { a: { on: 1, bright: 80, temp: -1 } };

  test('round-trips slots, caps and state', () => {
    const out = L.unpackModel(L.packModel(slots, caps, state));
    expect(out.slots).toEqual(slots);
    expect(out.capsById).toEqual(caps);
    expect(out.stateById).toEqual(state);
  });
  test('returns null for empty/garbage input', () => {
    expect(L.unpackModel(null)).toBeNull();
    expect(L.unpackModel('')).toBeNull();
    expect(L.unpackModel('{not json')).toBeNull();
    expect(L.unpackModel('{"v":999,"slots":[]}')).toBeNull();  // version mismatch
    expect(L.unpackModel('{"v":1}')).toBeNull();                // no slots array
  });
  test('a command is deliverable straight from the unpacked cache', () => {
    const m = L.unpackModel(L.packModel(slots, caps, state));
    expect(L.commandDeliverable('a', m.slots, m.capsById, m.stateById)).toBe(true);
  });
});

describe('mapDevicesToSlots', () => {
  test('keeps only switchable lights, carries online flag', () => {
    const devs = [
      { id: 'a', name: 'Lamp A', online: true },
      { id: 'b', name: 'Lamp B' }
    ];
    const caps = { a: { switchCode: 'switch_led' }, b: { switchCode: null } };
    const slots = L.mapDevicesToSlots(devs, caps);
    expect(slots).toEqual([{ index: 0, id: 'a', name: 'Lamp A', online: 1 }]);
  });

  test('sorts offline lights to the bottom and renumbers indices', () => {
    const devs = [
      { id: 'a', name: 'A', online: false },
      { id: 'b', name: 'B', online: true },
      { id: 'c', name: 'C', online: false },
      { id: 'd', name: 'D', online: true }
    ];
    const caps = { a: { switchCode: 'switch_led' }, b: { switchCode: 'switch_led' },
                   c: { switchCode: 'switch_led' }, d: { switchCode: 'switch_led' } };
    const slots = L.mapDevicesToSlots(devs, caps);
    expect(slots.map(function (s) { return s.id; })).toEqual(['b', 'd', 'a', 'c']);
    expect(slots.map(function (s) { return s.index; })).toEqual([0, 1, 2, 3]);
    expect(slots.map(function (s) { return s.online; })).toEqual([1, 1, 0, 0]);
  });
});

describe('actionToCommands with absolute desiredOn (from the watch-displayed state)', () => {
  const caps = { switchCode: 'switch_led', brightCode: 'bright_value_v2', brightMin: 10, brightMax: 1000,
                 tempCode: 'temp_value_v2', tempMin: 0, tempMax: 1000 };
  const ACT = L.ACTIONS;
  test('desiredOn=1 forces switch ON even if cached state is on', () => {
    expect(L.actionToCommands(ACT.TOGGLE, { on: 1, bright: 50, temp: 50 }, caps, 1))
      .toEqual([{ code: 'switch_led', value: true }]);
  });
  test('desiredOn=0 forces switch OFF even if cached state is off', () => {
    expect(L.actionToCommands(ACT.TOGGLE, { on: 0, bright: 50, temp: 50 }, caps, 0))
      .toEqual([{ code: 'switch_led', value: false }]);
  });
  test('absent desiredOn falls back to relative !state.on', () => {
    expect(L.actionToCommands(ACT.TOGGLE, { on: 1, bright: 50, temp: 50 }, caps))
      .toEqual([{ code: 'switch_led', value: false }]);
    expect(L.actionToCommands(ACT.TOGGLE, { on: 0, bright: 50, temp: 50 }, caps))
      .toEqual([{ code: 'switch_led', value: true }]);
  });
});

describe('applyActionToState with absolute desiredOn', () => {
  const caps = { switchCode: 'switch_led', brightCode: 'bright_value_v2', brightMin: 10, brightMax: 1000,
                 tempCode: 'temp_value_v2', tempMin: 0, tempMax: 1000 };
  const ACT = L.ACTIONS;
  test('desiredOn=1 sets on regardless of prior state', () => {
    expect(L.applyActionToState(ACT.TOGGLE, { on: 1, bright: 50, temp: 50 }, caps, 1))
      .toEqual({ on: 1, bright: 50, temp: 50 });
  });
  test('desiredOn=0 clears on regardless of prior state', () => {
    expect(L.applyActionToState(ACT.TOGGLE, { on: 0, bright: 50, temp: 50 }, caps, 0))
      .toEqual({ on: 0, bright: 50, temp: 50 });
  });
  test('absent desiredOn keeps relative flip', () => {
    expect(L.applyActionToState(ACT.TOGGLE, { on: 1, bright: 50, temp: 50 }, caps))
      .toEqual({ on: 0, bright: 50, temp: 50 });
  });
});
