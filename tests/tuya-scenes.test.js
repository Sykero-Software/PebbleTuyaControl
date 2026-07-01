const S = require('../src/pkjs/tuya-scenes');

describe('extractUid', () => {
  test('reads uid from the first device that has one', () => {
    expect(S.extractUid([{ id: 'a' }, { id: 'b', uid: 'U123' }])).toBe('U123');
  });
  test('null when no device carries a uid', () => {
    expect(S.extractUid([{ id: 'a' }])).toBeNull();
    expect(S.extractUid([])).toBeNull();
  });
});

describe('filterScenes', () => {
  test('keeps only enabled tap-to-run scenes and tags home_id', () => {
    const raw = [
      { scene_id: 's1', name: 'Movie', enabled: true, status: '1' },
      { scene_id: 's2', name: 'Off', enabled: false, status: '1' },
      { scene_id: 's3', name: 'Auto', enabled: true, status: '0' }
    ];
    expect(S.filterScenes(raw, 42)).toEqual([{ id: 's1', name: 'Movie', home_id: 42 }]);
  });
  test('tolerates an empty list', () => {
    expect(S.filterScenes([], 1)).toEqual([]);
  });
});

describe('buildCatalog', () => {
  test('includes switchable devices and scenes, drops non-switchable devices', () => {
    const devices = [{ id: 'a', name: 'Lamp' }, { id: 'b', name: 'Sensor' }];
    const caps = { a: { switchCode: 'switch_led' }, b: { switchCode: null } };
    const scenes = [{ id: 's1', name: 'Movie', home_id: 7 }];
    expect(S.buildCatalog(devices, caps, scenes)).toEqual({
      v: 1,
      items: [
        { kind: 'L', id: 'a', name: 'Lamp' },
        { kind: 'S', id: 's1', name: 'Movie', home_id: 7 }
      ]
    });
  });
});

describe('token helpers', () => {
  test('makeToken / parseToken round-trip', () => {
    expect(S.makeToken('L', 'dev1')).toBe('L:dev1');
    expect(S.parseToken('L:dev1')).toEqual({ kind: 'L', id: 'dev1' });
    expect(S.parseToken('S:scene1')).toEqual({ kind: 'S', id: 'scene1' });
  });
  test('parseToken rejects garbage', () => {
    expect(S.parseToken('X:foo')).toBeNull();
    expect(S.parseToken('Lfoo')).toBeNull();
    expect(S.parseToken('')).toBeNull();
    expect(S.parseToken(null)).toBeNull();
  });
});

describe('resolveSelection', () => {
  const devices = [{ id: 'a', name: 'Lamp A', online: true }, { id: 'b', name: 'Lamp B', online: false }];
  const caps = { a: { switchCode: 'switch_led' }, b: { switchCode: 'switch_led' } };
  const scenes = [{ id: 's1', name: 'Movie', home_id: 7 }];

  test('resolves tokens in order, preserving config order (no online-first sort)', () => {
    const out = S.resolveSelection(['S:s1', 'L:b', 'L:a'], devices, caps, scenes, 12);
    expect(out).toEqual([
      { index: 0, id: 's1', name: 'Movie', online: 1, kind: 'S' },
      { index: 1, id: 'b', name: 'Lamp B', online: 0, kind: 'L' },
      { index: 2, id: 'a', name: 'Lamp A', online: 1, kind: 'L' }
    ]);
  });
  test('drops tokens whose device/scene no longer exists', () => {
    const out = S.resolveSelection(['L:gone', 'S:missing', 'L:a'], devices, caps, scenes, 12);
    expect(out.map(function (s) { return s.id; })).toEqual(['a']);
  });
  test('drops a device that lost its switch capability', () => {
    const noSwitch = { a: { switchCode: null } };
    expect(S.resolveSelection(['L:a'], devices, noSwitch, scenes, 12)).toEqual([]);
  });
  test('caps at max entries', () => {
    const out = S.resolveSelection(['L:a', 'S:s1', 'L:b'], devices, caps, scenes, 2);
    expect(out.length).toBe(2);
    expect(out.map(function (s) { return s.id; })).toEqual(['a', 's1']);
  });
  test('tolerates a non-array selection', () => {
    expect(S.resolveSelection(undefined, devices, caps, scenes, 12)).toEqual([]);
  });
  test('defaults max to 12 when max is omitted', () => {
    const many = [];
    const caps = {};
    for (var i = 0; i < 20; i++) { many.push({ id: 'd' + i, name: 'D' + i, online: true }); caps['d' + i] = { switchCode: 'switch_led' }; }
    const sel = many.map(function (d) { return 'L:' + d.id; });
    expect(S.resolveSelection(sel, many, caps, undefined).length).toBe(12);
  });
});
