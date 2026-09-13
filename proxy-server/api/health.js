module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  return res.status(200).json({
    ok: true,
    version: '2.6.0',
    officialApiConfigured: Boolean(process.env.ER_OPEN_API_KEY)
  });
};
