const { buildStringToSign, buildSignString, EMPTY_BODY_SHA256 } = require('../src/pkjs/tuya-client');

describe('buildStringToSign', () => {
  test('GET with empty body and no query', () => {
    expect(buildStringToSign('GET', '/v1.0/token?grant_type=1', ''))
      .toBe('GET\n' + EMPTY_BODY_SHA256 + '\n\n/v1.0/token?grant_type=1');
  });

  test('POST hashes the body into the second line', () => {
    const s = buildStringToSign('POST', '/v1.0/iot-03/devices/abc/commands', '{"commands":[]}');
    const lines = s.split('\n');
    expect(lines[0]).toBe('POST');
    expect(lines[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[1]).not.toBe(EMPTY_BODY_SHA256);
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('/v1.0/iot-03/devices/abc/commands');
  });
});

describe('buildSignString', () => {
  const t = '1588925778000', nonce = 'n1', cid = 'CID';
  const sts = 'GET\nx\n\n/v1.0/token?grant_type=1';

  test('token request omits access_token', () => {
    expect(buildSignString({ clientId: cid, t, nonce, stringToSign: sts }))
      .toBe(cid + t + nonce + sts);
  });

  test('business request inserts access_token after client_id', () => {
    expect(buildSignString({ clientId: cid, accessToken: 'TOK', t, nonce, stringToSign: sts }))
      .toBe(cid + 'TOK' + t + nonce + sts);
  });
});

const { sign } = require('../src/pkjs/tuya-client');

describe('sign', () => {
  test('returns uppercase 64-char hex', () => {
    const out = sign('CID' + '1588925778000' + 'n1' + 'GET\nx\n\n/p', 'SECRET');
    expect(out).toMatch(/^[0-9A-F]{64}$/);
  });

  test('is deterministic and secret-dependent', () => {
    const str = 'abc';
    expect(sign(str, 'k1')).toBe(sign(str, 'k1'));
    expect(sign(str, 'k1')).not.toBe(sign(str, 'k2'));
  });
});
