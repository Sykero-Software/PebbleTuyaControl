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

const { createClient } = require('../src/pkjs/tuya-client');

function fakeHttp(responses) {
  const calls = [];
  function http(opts) {
    calls.push(opts);
    return Promise.resolve(responses.shift());
  }
  http.calls = calls;
  return http;
}

const cfg = { clientId: 'CID', secret: 'SEC', host: 'https://openapi.tuyaeu.com' };
const deps = { now: () => 1588925778000, nonce: () => 'NONCE' };

test('getToken signs a token request (no access_token header)', async () => {
  const http = fakeHttp([{ success: true, result: { access_token: 'TOK', expire_time: 7200 } }]);
  const c = createClient(cfg, http, deps);
  const tok = await c.getToken();
  expect(tok).toBe('TOK');
  const call = http.calls[0];
  expect(call.method).toBe('GET');
  expect(call.url).toBe('https://openapi.tuyaeu.com/v1.0/token?grant_type=1');
  expect(call.headers.client_id).toBe('CID');
  expect(call.headers.sign_method).toBe('HMAC-SHA256');
  expect(call.headers.t).toBe('1588925778000');
  expect(call.headers.sign).toMatch(/^[0-9A-F]{64}$/);
  expect(call.headers.access_token).toBeUndefined();
});

test('request() fetches a token first, then signs with access_token', async () => {
  const http = fakeHttp([
    { success: true, result: { access_token: 'TOK', expire_time: 7200 } },
    { success: true, result: { devices: [] } }
  ]);
  const c = createClient(cfg, http, deps);
  const res = await c.request('GET', '/v1.0/iot-01/associated-users/devices');
  expect(res.result.devices).toEqual([]);
  expect(http.calls[1].headers.access_token).toBe('TOK');
  expect(http.calls[1].headers.sign).toMatch(/^[0-9A-F]{64}$/);
});

test('request() throws on a non-auth API error envelope (no retry)', async () => {
  const http = fakeHttp([
    { success: true, result: { access_token: 'TOK', expire_time: 7200 } },
    { success: false, code: 2007, msg: 'device offline' }
  ]);
  const c = createClient(cfg, http, deps);
  await expect(c.request('GET', '/x')).rejects.toThrow(/2007/);
  expect(http.calls.length).toBe(2); // token + one business call, no retry
});

test('request() clears the token and retries once on a 1010 auth error', async () => {
  const http = fakeHttp([
    { success: true, result: { access_token: 'TOK1', expire_time: 7200 } }, // initial token
    { success: false, code: 1010, msg: 'token invalid' },                   // business call fails auth
    { success: true, result: { access_token: 'TOK2', expire_time: 7200 } }, // fresh token
    { success: true, result: { ok: 1 } }                                    // retried business call OK
  ]);
  const c = createClient(cfg, http, deps);
  const res = await c.request('GET', '/x');
  expect(res.result.ok).toBe(1);
  expect(http.calls.length).toBe(4);                 // token, fail, re-token, retry
  expect(http.calls[3].headers.access_token).toBe('TOK2'); // retry used the fresh token
});

test('request() does not retry more than once on persistent 1010', async () => {
  const http = fakeHttp([
    { success: true, result: { access_token: 'TOK1', expire_time: 7200 } },
    { success: false, code: 1010, msg: 'token invalid' },
    { success: true, result: { access_token: 'TOK2', expire_time: 7200 } },
    { success: false, code: 1010, msg: 'token invalid' }
  ]);
  const c = createClient(cfg, http, deps);
  await expect(c.request('GET', '/x')).rejects.toThrow(/1010/);
  expect(http.calls.length).toBe(4); // no infinite retry loop
});
