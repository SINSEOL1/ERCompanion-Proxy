module.exports = function handler(req, res) {
  const expiresRaw = (process.env.PROXY_EXPIRES_AT || '').trim();
  const expiresAt = expiresRaw && Number.isFinite(Date.parse(expiresRaw))
    ? new Date(expiresRaw).toISOString()
    : null;

  return res.status(200).json({
    service: 'Eternal Return Open API Temporary Proxy',
    version: '3.0.0',
    status: 'ok',
    configured: Boolean(process.env.ER_OPEN_API_KEY && process.env.PROXY_ACCESS_TOKEN),
    expiresAt,
    endpoint: '/er/<official-api-path>',
    auth: 'Authorization: Bearer <temporary-token>',
  });
};
