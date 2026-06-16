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
  test('defaults: quick-toggle on, auto-close off when keys absent', () => {
    expect(L.cfgToInts({})).toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0 });
    expect(L.cfgToInts(undefined)).toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0 });
  });
  test('maps booleans to ints', () => {
    expect(L.cfgToInts({ CfgQuickToggle: false, CfgAutoClose: true }))
      .toEqual({ CfgQuickToggle: 0, CfgAutoClose: 1 });
    expect(L.cfgToInts({ CfgQuickToggle: true, CfgAutoClose: false }))
      .toEqual({ CfgQuickToggle: 1, CfgAutoClose: 0 });
  });
});

describe('commandDeliverable', () => {
  const slots = [{ index: 0, id: 'A' }];
  test('false when slot missing', () => {
    expect(L.commandDeliverable(0, [], {}, {})).toBe(false);
  });
  test('false when caps or state missing', () => {
    expect(L.commandDeliverable(0, slots, {}, { A: { on: 0 } })).toBe(false);
    expect(L.commandDeliverable(0, slots, { A: { switchCode: 's' } }, {})).toBe(false);
  });
  test('true when slot, caps and state are present', () => {
    expect(L.commandDeliverable(0, slots, { A: { switchCode: 's' } }, { A: { on: 0 } })).toBe(true);
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
