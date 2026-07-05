const { sign } = require("../lib/oauthCrypto");

// Auto-approving authorize endpoint. A normal OAuth provider would show a
// login + consent screen here. Since this server exists solely for your own
// personal use (not a multi-tenant service), we skip that and immediately
// redirect back with a valid code — equivalent to you having already
// approved access by virtue of deploying this yourself with your own secret.
module.exports = (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;

  if (!redirect_uri) {
    res.status(400).send("Missing redirect_uri");
    return;
  }
  if (code_challenge_method && code_challenge_method !== "S256") {
    res.status(400).send("Only S256 code_challenge_method is supported");
    return;
  }

  const code = sign({
    redirect_uri,
    code_challenge: code_challenge || null,
    exp: Date.now() + 5 * 60 * 1000, // 5 minute validity, plenty for an immediate redirect
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  res.writeHead(302, { Location: redirectUrl.toString() });
  res.end();
};
