const crypto = require('crypto');

const OFFICIAL_BASE = 'https://open-api.bser.io';
const DEFAULT_LIMIT_PER_MINUTE = 30;

const rateBuckets = globalThis.__ER_TEMP_PROXY_RATE_BUCKETS__ || new Map();
globalThis.__ER_TEMP_PROXY_RATE_BUCKETS__ = rateBuckets;

function getAllowedOrigin(req) {
  const configured = (process.env.PROXY_ALLOWED_ORIGIN || '*').trim();
  if (configured === '*') return '*';

  const requestOrigin = String(req.headers?.origin || '');
  const allowed = configured
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  return allowed.includes(requestOrigin) ? requestOrigin : allowed[0] || 'null';
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', getAllowedOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getBearerToken(req) {
  const raw = String(req.headers?.authorization || '');
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isExpired() {
  const raw = (process.env.PROXY_EXPIRES_AT || '').trim();
  if (!raw) return false;

  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return true;
  return Date.now() >= time;
}

function getRateLimit() {
  const parsed = Number(process.env.PROXY_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_LIMIT_PER_MINUTE;
}

function consumeRate(token) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = getRateLimit();
  const key = crypto.createHash('sha256').update(token).digest('hex');

  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: bucket.startedAt + windowMs,
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.startedAt + windowMs,
  };
}

function normalizePath(raw) {
  let value = Array.isArray(raw) ? raw.join('/') : String(raw || '');
  value = value.trim().replace(/^\/+/, '');

  if (!value) return null;
  if (value.includes('\0') || value.includes('\\') || value.includes('://')) return null;

  // Prevent path traversal even when URL-encoded.
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch (_) {}
  if (decoded.split('/').some(part => part === '..' || part === '.')) return null;

  // Eternal Return Open API currently uses versioned paths such as /v1/... and /v2/....
  // Accept future numeric API versions without turning this into an arbitrary open proxy.
  if (!/^v\d+\//i.test(value)) return null;

  return value;
}

function appendQuery(url, query) {
  for (const [key, value] of Object.entries(query || {})) {
    if (key === 'path' || value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
}

function getRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (req.body === undefined || req.body === null) return undefined;

  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
    return req.body;
  }

  return JSON.stringify(req.body);
}

function copyResponseHeaders(upstream, res) {
  const allowed = [
    'content-type',
    'content-language',
    'cache-control',
    'etag',
    'last-modified',
    'retry-after',
  ];

  for (const name of allowed) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const officialKey = (process.env.ER_OPEN_API_KEY || '').trim();
  const accessToken = (process.env.PROXY_ACCESS_TOKEN || '').trim();

  if (!officialKey || !accessToken) {
    return res.status(500).json({
      error: 'proxy_not_configured',
      message: 'ER_OPEN_API_KEY and PROXY_ACCESS_TOKEN must be configured.',
    });
  }

  if (isExpired()) {
    return res.status(403).json({
      error: 'proxy_access_expired',
      message: 'Temporary proxy access has expired.',
    });
  }

  const providedToken = getBearerToken(req);
  if (!providedToken || !safeEqual(providedToken, accessToken)) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Use Authorization: Bearer <temporary-token>.',
    });
  }

  const rate = consumeRate(providedToken);
  res.setHeader('X-RateLimit-Limit', String(rate.limit));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)));

  if (!rate.allowed) {
    return res.status(429).json({
      error: 'proxy_rate_limited',
      message: 'Temporary proxy request limit exceeded.',
    });
  }

  const path = normalizePath(req.query?.path);
  if (!path) {
    return res.status(400).json({
      error: 'invalid_path',
      message: 'Only versioned Eternal Return API paths such as v1/... or v2/... are allowed.',
    });
  }

  const upstreamUrl = new URL(`/${path}`, OFFICIAL_BASE);
  appendQuery(upstreamUrl, req.query);

  const headers = {
    'x-api-key': officialKey,
    'accept': String(req.headers?.accept || 'application/json'),
    'user-agent': 'ER-Temporary-Proxy/3.0',
  };

  const contentType = req.headers?.['content-type'];
  if (contentType) headers['content-type'] = String(contentType);

  const controller = new AbortController();
  const timeoutMs = Math.max(
    1000,
    Math.min(9000, Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS) || 8000)
  );
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: getRequestBody(req),
      signal: controller.signal,
      redirect: 'manual',
    });

    clearTimeout(timeout);
    copyResponseHeaders(upstream, res);

    // Never expose the real ER key or upstream request headers.
    res.setHeader('X-Proxy-Upstream-Status', String(upstream.status));

    const body = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(body);
  } catch (error) {
    clearTimeout(timeout);

    if (error?.name === 'AbortError') {
      return res.status(504).json({
        error: 'upstream_timeout',
        message: 'Eternal Return Open API did not respond in time.',
      });
    }

    console.error('[ER proxy] upstream error:', error);
    return res.status(502).json({
      error: 'upstream_error',
      message: 'Failed to reach Eternal Return Open API.',
    });
  }
};

// Export helpers only for local smoke tests. Vercel ignores these exports.
module.exports._test = {
  normalizePath,
  appendQuery,
  safeEqual,
};
