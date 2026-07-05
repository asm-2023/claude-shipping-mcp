const { verify, verifyPkce } = require("../lib/oauthCrypto");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }

  const body = req.body || {};

  if (body.grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  const decoded = verify(body.code);
  if (!decoded) {
    res.status(400).json({ error: "invalid_grant", error_description: "code invalid or expired" });
    return;
  }

  if (decoded.redirect_uri !== body.redirect_uri) {
    res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    return;
  }

  if (decoded.code_challenge) {
    if (!body.code_verifier || !verifyPkce(body.code_verifier, decoded.code_challenge)) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
  }

  // The "access token" we hand back is just your existing static MCP token —
  // there's no separate token store since this server only ever serves you.
  res.status(200).json({
    access_token: process.env.MCP_ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 31536000, // 1 year; reissue by reconnecting the connector if you ever rotate MCP_ACCESS_TOKEN
  });
};
