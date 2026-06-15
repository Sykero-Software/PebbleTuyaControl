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

module.exports = {
  buildStringToSign: buildStringToSign,
  buildSignString: buildSignString,
  sign: sign,
  EMPTY_BODY_SHA256: EMPTY_BODY_SHA256
};
