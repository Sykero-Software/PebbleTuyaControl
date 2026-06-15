var sha256 = require('js-sha256');

var EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// urlPath includes the query string already (sorted by caller when present).
function buildStringToSign(method, urlPath, bodyStr) {
  var contentHash = (bodyStr && bodyStr.length) ? sha256(bodyStr) : EMPTY_BODY_SHA256;
  // Signature-Headers unused -> empty third line.
  return method + '\n' + contentHash + '\n' + '\n' + urlPath;
}

function buildSignString(o) {
  var head = o.accessToken ? (o.clientId + o.accessToken) : o.clientId;
  return head + o.t + o.nonce + o.stringToSign;
}

function sign(signString, secret) {
  return sha256.hmac(secret, signString).toUpperCase();
}

function createClient(cfg, http, deps) {
  var token = null;
  var tokenExpiresAt = 0;

  function headersFor(method, urlPath, bodyStr, accessToken) {
    var t = String(deps.now());
    var nonce = deps.nonce();
    var sts = buildStringToSign(method, urlPath, bodyStr);
    var signStr = buildSignString({
      clientId: cfg.clientId, accessToken: accessToken, t: t, nonce: nonce, stringToSign: sts
    });
    var h = {
      client_id: cfg.clientId,
      sign: sign(signStr, cfg.secret),
      sign_method: 'HMAC-SHA256',
      t: t,
      nonce: nonce,
      'Content-Type': 'application/json'
    };
    if (accessToken) h.access_token = accessToken;
    return h;
  }

  function getToken() {
    var urlPath = '/v1.0/token?grant_type=1';
    return http({
      method: 'GET', url: cfg.host + urlPath,
      headers: headersFor('GET', urlPath, '', null)
    }).then(function (resp) {
      if (!resp || !resp.success) throw new Error('token error ' + (resp && resp.code));
      token = resp.result.access_token;
      tokenExpiresAt = deps.now() + (resp.result.expire_time - 60) * 1000;
      return token;
    });
  }

  function ensureToken() {
    if (token && deps.now() < tokenExpiresAt) return Promise.resolve(token);
    return getToken();
  }

  function request(method, urlPath, body) {
    var bodyStr = body ? JSON.stringify(body) : '';
    return ensureToken().then(function (tok) {
      return http({
        method: method, url: cfg.host + urlPath, body: bodyStr,
        headers: headersFor(method, urlPath, bodyStr, tok)
      });
    }).then(function (resp) {
      if (!resp || !resp.success) {
        var e = new Error('Tuya API error ' + (resp && resp.code) + ': ' + (resp && resp.msg));
        e.code = resp && resp.code;
        throw e;
      }
      return resp;
    });
  }

  return { getToken: getToken, request: request };
}

module.exports = {
  buildStringToSign: buildStringToSign,
  buildSignString: buildSignString,
  sign: sign,
  createClient: createClient,
  EMPTY_BODY_SHA256: EMPTY_BODY_SHA256
};
