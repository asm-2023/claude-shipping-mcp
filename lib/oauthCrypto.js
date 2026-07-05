const crypto = require("crypto");

// We avoid needing a database by making the "authorization code" a signed,
// self-contained token: base64url(payload) + "." + hmac(payload). The token
// endpoint just verifies the signature + expiry + PKCE challenge, entirely
// statelessly. Secret reuses MCP_ACCESS_TOKEN so no extra env var is needed.

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payloadObj) {
  const payload = b64url(Buffer.from(JSON.stringify(payloadObj)));
  const hmac = b64url(
    crypto.createHmac("sha256", process.env.MCP_ACCESS_TOKEN).update(payload).digest()
  );
  return `${payload}.${hmac}`;
}

function verify(token) {
  const [payload, hmac] = String(token).split(".");
  if (!payload || !hmac) return null;
  const expected = b64url(
    crypto.createHmac("sha256", process.env.MCP_ACCESS_TOKEN).update(payload).digest()
  );
  if (expected !== hmac) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (decoded.exp && Date.now() > decoded.exp) return null;
    return decoded;
  } catch {
    return null;
  }
}

function verifyPkce(codeVerifier, codeChallenge) {
  const hash = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  return hash === codeChallenge;
}

module.exports = { sign, verify, verifyPkce, b64url };
