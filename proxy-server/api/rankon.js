const OFFICIAL_BASE = 'https://open-api.bser.io';
const DEFAULT_RATE_LIMIT = 30;

const cache = globalThis.__RANKON_PROXY_CACHE__ || new Map();
const rateBuckets = globalThis.__RANKON_PROXY_RATE_BUCKETS__ || new Map();
globalThis.__RANKON_PROXY_CACHE__ = cache;
globalThis.__RANKON_PROXY_RATE_BUCKETS__ = rateBuckets;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function getClientKey(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket?.remoteAddress || 'unknown');
}

function getRateLimit() {
  const parsed = Number(process.env.RANKON_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RATE_LIMIT;
}

function consumeRate(key) {
  const now = Date.now();
  const limit = getRateLimit();
  const windowMs = 60_000;
  let bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }

  if (bucket.count >= limit) {
    return false;
  }

  bucket.count += 1;
  return true;
}

async function cached(key, ttlMs, factory) {
  const now = Date.now();
  const existing = cache.get(key);

  if (existing && existing.expiresAt > now) {
    return existing.value;
  }

  const value = await factory();
  cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

async function official(path) {
  const apiKey = String(process.env.ER_OPEN_API_KEY || '').trim();

  if (!apiKey) {
    const error = new Error('ER_OPEN_API_KEY is not configured.');
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(new URL(path, OFFICIAL_BASE), {
    headers: {
      'x-api-key': apiKey,
      'accept': 'application/json',
      'user-agent': 'RankOn-Proxy/1.0',
    },
    signal: AbortSignal.timeout(8000),
  });

  const text = await response.text();

  if (!response.ok) {
    const error = new Error(text || `Upstream request failed with ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Invalid JSON response from Eternal Return Open API.');
    error.statusCode = 502;
    throw error;
  }
}

function seasonDateToIso(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) return raw;
  return raw.replace(' ', 'T') + '+09:00';
}

async function getCurrentSeason() {
  return cached('season:current', 10 * 60_000, async () => {
    const payload = await official('/v2/data/Season');
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.Season)
        ? payload.Season
        : Array.isArray(payload)
          ? payload
          : [];
    const now = Date.now();

    let current = rows.find(row => Number(row?.isCurrent) === 1 || row?.isCurrent === true);

    if (!current) {
      current = rows.find(row => {
        const start = Date.parse(seasonDateToIso(row?.seasonStart) || '');
        const end = Date.parse(seasonDateToIso(row?.seasonEnd) || '');
        return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
      });
    }

    if (!current) {
      current = [...rows].sort((a, b) =>
        Number(b?.seasonID ?? b?.seasonId ?? 0) - Number(a?.seasonID ?? a?.seasonId ?? 0)
      )[0];
    }

    if (!current) {
      const error = new Error('Current season could not be resolved.');
      error.statusCode = 502;
      throw error;
    }

    return {
      seasonId: Number(current.seasonID ?? current.seasonId),
      seasonName: String(current.seasonName || ''),
      seasonStart: seasonDateToIso(current.seasonStart),
      seasonEnd: seasonDateToIso(current.seasonEnd),
    };
  });
}

async function getCuts(seasonId) {
  return cached(`cuts:${seasonId}`, 45_000, async () => {
    const payload = await official(`/v1/rank/top/${seasonId}/3`);
    const ranks = Array.isArray(payload?.topRanks)
      ? payload.topRanks
      : Array.isArray(payload?.data?.topRanks)
        ? payload.data.topRanks
        : Array.isArray(payload?.data)
          ? payload.data
          : [];

    const normalized = ranks
      .map(item => ({
        rank: Number(item?.rank || 0),
        rp: Number(item?.mmr || 0),
      }))
      .filter(item => item.rank > 0 && item.rp >= 0)
      .sort((a, b) => a.rank - b.rank);

    const eternity = [...normalized].reverse().find(item => item.rank <= 300) || null;
    const demigod = [...normalized].reverse().find(item => item.rank <= 1000) || normalized.at(-1) || null;

    return {
      eternityRank: 300,
      eternityRp: eternity?.rp ?? null,
      demigodRank: 1000,
      demigodRp: demigod?.rp ?? null,
      sampledRanks: normalized.length,
    };
  });
}

function getTier(rp, rank) {
  if (rank > 0 && rank <= 300) {
    return { key: 'eternity', nameKo: '이터니티', division: null };
  }

  if (rank > 300 && rank <= 1000) {
    return { key: 'demigod', nameKo: '데미갓', division: null };
  }

  const tiers = [
    [7600, 'mythril', '미스릴', null],
    [7300, 'meteorite', '메테오라이트', 1],
    [7000, 'meteorite', '메테오라이트', 2],
    [6700, 'meteorite', '메테오라이트', 3],
    [6400, 'meteorite', '메테오라이트', 4],
    [6050, 'diamond', '다이아몬드', 1],
    [5700, 'diamond', '다이아몬드', 2],
    [5350, 'diamond', '다이아몬드', 3],
    [5000, 'diamond', '다이아몬드', 4],
    [4650, 'platinum', '플래티넘', 1],
    [4300, 'platinum', '플래티넘', 2],
    [3950, 'platinum', '플래티넘', 3],
    [3600, 'platinum', '플래티넘', 4],
    [3300, 'gold', '골드', 1],
    [3000, 'gold', '골드', 2],
    [2700, 'gold', '골드', 3],
    [2400, 'gold', '골드', 4],
    [2150, 'silver', '실버', 1],
    [1900, 'silver', '실버', 2],
    [1650, 'silver', '실버', 3],
    [1400, 'silver', '실버', 4],
    [1200, 'bronze', '브론즈', 1],
    [1000, 'bronze', '브론즈', 2],
    [800, 'bronze', '브론즈', 3],
    [600, 'bronze', '브론즈', 4],
    [450, 'iron', '아이언', 1],
    [300, 'iron', '아이언', 2],
    [150, 'iron', '아이언', 3],
    [0, 'iron', '아이언', 4],
  ];

  const tier = tiers.find(([minimum]) => rp >= minimum) || tiers.at(-1);
  return { key: tier[1], nameKo: tier[2], division: tier[3] };
}

function getNextTierTarget(tier, rp, cuts) {
  const regularTargets = {
    iron: { tierKey: 'bronze', tierNameKo: '브론즈', rp: 600 },
    bronze: { tierKey: 'silver', tierNameKo: '실버', rp: 1400 },
    silver: { tierKey: 'gold', tierNameKo: '골드', rp: 2400 },
    gold: { tierKey: 'platinum', tierNameKo: '플래티넘', rp: 3600 },
    platinum: { tierKey: 'diamond', tierNameKo: '다이아몬드', rp: 5000 },
    diamond: { tierKey: 'meteorite', tierNameKo: '메테오라이트', rp: 6400 },
    meteorite: { tierKey: 'mythril', tierNameKo: '미스릴', rp: 7600 },
  };

  if (tier.key === 'mythril' && cuts.demigodRp != null) {
    return {
      tierKey: 'demigod',
      tierNameKo: '데미갓',
      rp: cuts.demigodRp,
      remainingRp: Math.max(0, cuts.demigodRp - rp),
    };
  }

  if (tier.key === 'demigod' && cuts.eternityRp != null) {
    return {
      tierKey: 'eternity',
      tierNameKo: '이터니티',
      rp: cuts.eternityRp,
      remainingRp: Math.max(0, cuts.eternityRp - rp),
    };
  }

  if (tier.key === 'eternity') {
    return null;
  }

  const target = regularTargets[tier.key];

  if (!target) {
    return null;
  }

  return {
    ...target,
    remainingRp: Math.max(0, target.rp - rp),
  };
}

async function resolveNickname(nickname) {
  const key = nickname.toLocaleLowerCase('en-US');

  return cached(`resolve:${key}`, 15 * 60_000, async () => {
    const payload = await official(`/v1/user/nickname?query=${encodeURIComponent(nickname)}`);
    const user = payload?.user ?? payload?.data?.user ?? payload?.data ?? null;
    const uid = user?.uid ?? user?.userId ?? user?.id ?? null;

    if (!uid) {
      const error = new Error(
        `Player lookup returned no UID. code=${payload?.code ?? 'unknown'} message=${payload?.message ?? 'unknown'}`
      );
      error.statusCode = Number(payload?.code) === 404 ? 404 : 502;
      throw error;
    }

    return {
      uid: String(uid),
      nickname: String(user?.nickname || nickname),
    };
  });
}

async function getRankState(uid) {
  const season = await getCurrentSeason();

  const [rankPayload, cuts] = await Promise.all([
    cached(`rank:${uid}:${season.seasonId}`, 30_000, () =>
      official(`/v1/rank/uid/${encodeURIComponent(uid)}/${season.seasonId}/3`)
    ),
    getCuts(season.seasonId),
  ]);

  const rankData = rankPayload?.userRank ?? rankPayload?.data?.userRank ?? rankPayload?.data ?? null;

  if (!rankData) {
    const error = new Error('Rank data not found for the current season.');
    error.statusCode = 404;
    throw error;
  }

  const rp = Number(rankData.mmr || 0);
  const rank = Number(rankData.rank || 0);
  const tier = getTier(rp, rank);
  const nextTier = getNextTierTarget(tier, rp, cuts);

  let nextCut = null;

  if (rank > 1000 && cuts.demigodRp != null) {
    nextCut = {
      tierKey: 'demigod',
      tierNameKo: '데미갓',
      rp: cuts.demigodRp,
      remainingRp: Math.max(0, cuts.demigodRp - rp),
    };
  } else if (rank > 300 && cuts.eternityRp != null) {
    nextCut = {
      tierKey: 'eternity',
      tierNameKo: '이터니티',
      rp: cuts.eternityRp,
      remainingRp: Math.max(0, cuts.eternityRp - rp),
    };
  }

  return {
    nickname: String(rankData.nickname || ''),
    uid,
    season,
    rp,
    rank,
    serverCode: Number(rankData.serverCode || 0),
    serverRank: Number(rankData.serverRank || 0),
    tier,
    cuts,
    nextTier,
    nextCut,
  };
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!consumeRate(getClientKey(req))) {
    return res.status(429).json({
      error: 'rate_limited',
      message: 'Too many RankOn requests.',
    });
  }

  const action = String(req.query?.action || '').trim().toLowerCase();

  try {
    if (action === 'season') {
      return res.status(200).json(await getCurrentSeason());
    }

    if (action === 'cuts') {
      const season = await getCurrentSeason();
      return res.status(200).json({
        season,
        cuts: await getCuts(season.seasonId),
      });
    }

    if (action === 'resolve') {
      const nickname = String(req.query?.nickname || '').trim();

      if (!nickname || nickname.length > 30) {
        return res.status(400).json({ error: 'invalid_nickname' });
      }

      return res.status(200).json(await resolveNickname(nickname));
    }

    if (action === 'rank') {
      const uid = String(req.query?.uid || '').trim();

      if (!uid || uid.length > 128) {
        return res.status(400).json({ error: 'invalid_uid' });
      }

      return res.status(200).json(await getRankState(uid));
    }

    if (action === 'profile') {
      const nickname = String(req.query?.nickname || '').trim();

      if (!nickname || nickname.length > 30) {
        return res.status(400).json({ error: 'invalid_nickname' });
      }

      const resolved = await resolveNickname(nickname);
      return res.status(200).json(await getRankState(resolved.uid));
    }

    return res.status(400).json({
      error: 'invalid_action',
      actions: ['resolve', 'rank', 'profile', 'cuts', 'season'],
    });
  } catch (error) {
    const status = Number(error?.statusCode) || 502;
    return res.status(status >= 400 && status <= 599 ? status : 502).json({
      error: status === 404 ? 'not_found' : 'upstream_error',
      message: String(error?.message || 'RankOn proxy request failed.'),
    });
  }
};
