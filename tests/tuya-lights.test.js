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

describe('mapDevicesToSlots', () => {
  test('keeps only switchable lights, max 12', () => {
    const devs = [
      { id: 'a', name: 'Lamp A' },
      { id: 'b', name: 'Lamp B' }
    ];
    const caps = { a: { switchCode: 'switch_led' }, b: { switchCode: null } };
    const slots = L.mapDevicesToSlots(devs, caps);
    expect(slots).toEqual([{ index: 0, id: 'a', name: 'Lamp A' }]);
  });
});
