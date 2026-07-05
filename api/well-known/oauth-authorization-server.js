module.exports = (req, res) => {
  const origin = `https://${req.headers.host}`;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/authorize`,
    token_endpoint: `${origin}/api/token`,
    registration_endpoint: `${origin}/api/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
};
