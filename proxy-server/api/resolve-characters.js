const fs = require('fs');
const path = require('path');

const OFFICIAL_BASE = 'https://open-api.bser.io';
const NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'character_names.json'), 'utf8'));
const CACHE_TTL_MS = 90_000;
const MAX_CACHE = 500;
const cache = globalThis.__ERCOMPANION_IDENTITY_CACHE__ || new Map();
globalThis.__ERCOMPANION_IDENTITY_CACHE__ = cache;
const rateBuckets = globalThis.__ERCOMPANION_RATE_BUCKETS__ || new Map();
globalThis.__ERCOMPANION_RATE_BUCKETS__ = rateBuckets;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const apiKey = process.env.ER_OPEN_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'proxy_not_configured' });

  if (!consumeRate(req)) return res.status(429).json({ error: 'rate_limited', mappings: [] });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const nickname = normalizeNickname(body.nickname);
    const mode = Number(body.mode);
    const seasonKey = String(body.seasonKey || '');
    const rows = normalizeRows(body.rows);

    if (!nickname || nickname.length > 40) return res.status(400).json({ error: 'invalid_nickname' });
    if (![2, 3, 6].includes(mode)) return res.status(400).json({ error: 'invalid_mode' });
    if (!rows.length) return res.status(200).json({ mappings: [] });

    const cacheKey = makeCacheKey(nickname, mode, seasonKey, rows);
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return res.status(200).json(cached.value);
    }

    const userJson = await officialGet(`/v1/user/nickname?query=${encodeURIComponent(nickname)}`, apiKey);
    const user = userJson.user || userJson.data?.user || userJson.data;
    const uid = user?.uid || user?.userId;
    if (!uid) return res.status(404).json({ error: 'player_not_found', mappings: [] });

    // Recent games serve two purposes: they reveal the official characterNum and provide
    // kill/damage fingerprints for rows whose play/win counts collide.
    const gamesJson = await officialGet(`/v1/user/games/uid/${encodeURIComponent(uid)}`, apiKey);
    const allGames = Array.isArray(gamesJson.userGames) ? gamesJson.userGames
      : Array.isArray(gamesJson.data?.userGames) ? gamesJson.data.userGames
      : [];

    const modeGamesAll = allGames.filter(g => Number(g.matchingMode) === mode);
    const detectedSeasonId = detectSeasonId(modeGamesAll, seasonKey, mode);
    let seasonGames = filterSeasonGames(modeGamesAll, detectedSeasonId, mode);

    let statsCandidates = [];
    if (mode === 2 || mode === 3) {
      // Official API requires 0 for Normal. Ranked uses the detected current official season.
      const statsSeasonId = mode === 2 ? 0 : detectedSeasonId;
      if (mode === 2 || statsSeasonId > 0) {
        try {
          const statsJson = await officialGet(`/v2/user/stats/uid/${encodeURIComponent(uid)}/${statsSeasonId}/${mode}`, apiKey);
          statsCandidates = parseStatsCandidates(statsJson);
        } catch (err) {
          // Identity can still be resolved from recent games; don't fail the whole request.
          if (!isExpectedMissing(err)) throw err;
        }
      }
    }

    // If season filtering found nothing (common around season transitions), keep the mode-only
    // recent games as a fallback fingerprint source.
    if (!seasonGames.length) seasonGames = modeGamesAll;
    const gameCandidates = aggregateGames(seasonGames);
    const candidates = mergeCandidates(statsCandidates, gameCandidates);
    const mappings = resolveRows(rows, candidates);

    const value = {
      nickname: user?.nickname || nickname,
      officialSeasonId: detectedSeasonId || null,
      mappings
    };
    putCache(cacheKey, value);
    res.setHeader('Cache-Control', 'private, max-age=15');
    return res.status(200).json(value);
  } catch (err) {
    const status = Number(err?.status) || 500;
    const safeStatus = [400, 403, 404, 429].includes(status) ? status : 500;
    return res.status(safeStatus).json({
      error: safeStatus === 429 || safeStatus === 403 ? 'official_api_rate_limited' : 'proxy_error',
      mappings: []
    });
  }
};

function normalizeNickname(value) {
  return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().normalize('NFC');
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of rows.slice(0, 24)) {
    const localKey = toInt(raw?.localKey);
    const play = toInt(raw?.play);
    if (localKey <= 0 || play <= 0 || seen.has(localKey)) continue;
    seen.add(localKey);
    result.push({
      localKey,
      play,
      win: Math.max(0, toInt(raw?.win)),
      playerKill: Math.max(0, toNum(raw?.playerKill)),
      damageToPlayer: Math.max(0, toNum(raw?.damageToPlayer))
    });
  }
  return result;
}

async function officialGet(urlPath, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(OFFICIAL_BASE + urlPath, {
      headers: {
        'x-api-key': apiKey,
        'accept': 'application/json',
        'user-agent': 'ERCompanion-Identity-Proxy/2.6.0'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`official_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function detectSeasonId(games, seasonKey, mode) {
  if (mode === 2) return 0;
  const sorted = games
    .filter(g => toInt(g.seasonId) > 0)
    .sort((a, b) => Date.parse(b.startDtm || 0) - Date.parse(a.startDtm || 0));
  if (sorted.length) return toInt(sorted[0].seasonId);
  const match = String(seasonKey || '').match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function filterSeasonGames(games, seasonId, mode) {
  if (mode === 2) {
    // Normal stats endpoint uses seasonId=0, while game rows can carry either 0 or a live season id.
    // Keep all recent Normal games; the matching scorer will prefer exact fingerprints.
    return games;
  }
  if (seasonId <= 0) return games;
  return games.filter(g => toInt(g.seasonId) === seasonId);
}

function parseStatsCandidates(json) {
  const stats = Array.isArray(json.userStats) ? json.userStats
    : Array.isArray(json.data?.userStats) ? json.data.userStats
    : [];
  const preferred = stats.find(s => toInt(s.matchingTeamMode) === 3) || stats[0];
  const rows = Array.isArray(preferred?.characterStats) ? preferred.characterStats : [];
  return rows.map(x => ({
    code: toInt(x.characterCode),
    statsGames: toInt(x.totalGames),
    statsWins: toInt(x.wins),
    recentGames: 0,
    recentWins: 0,
    kills: 0,
    damage: 0,
    name: characterName(toInt(x.characterCode))
  })).filter(x => x.code > 0);
}

function aggregateGames(games) {
  const map = new Map();
  for (const g of games) {
    const code = toInt(g.characterNum);
    if (code <= 0) continue;
    let c = map.get(code);
    if (!c) {
      c = { code, statsGames: 0, statsWins: 0, recentGames: 0, recentWins: 0, kills: 0, damage: 0, name: characterName(code) };
      map.set(code, c);
    }
    c.recentGames += 1;
    c.recentWins += toInt(g.victory) > 0 || toInt(g.gameRank) === 1 ? 1 : 0;
    c.kills += Math.max(0, toNum(g.playerKill));
    c.damage += Math.max(0, toNum(g.damageToPlayer));
  }
  return [...map.values()];
}

function mergeCandidates(stats, games) {
  const map = new Map();
  for (const c of stats) map.set(c.code, { ...c });
  for (const g of games) {
    const c = map.get(g.code) || { code: g.code, statsGames: 0, statsWins: 0, name: g.name };
    c.recentGames = g.recentGames;
    c.recentWins = g.recentWins;
    c.kills = g.kills;
    c.damage = g.damage;
    c.name = c.name || g.name;
    map.set(g.code, c);
  }
  return [...map.values()].filter(c => c.code > 0);
}

function resolveRows(rows, candidates) {
  const unresolvedRows = new Set(rows.map((_, i) => i));
  const unusedCodes = new Set(candidates.map(c => c.code));
  const out = [];

  while (unresolvedRows.size && unusedCodes.size) {
    let best = null;
    for (const rowIndex of unresolvedRows) {
      const row = rows[rowIndex];
      for (const c of candidates) {
        if (!unusedCodes.has(c.code)) continue;
        const scored = score(row, c);
        if (!best || scored.cost < best.cost || (scored.cost === best.cost && scored.confidence > best.confidence)) {
          best = { rowIndex, candidate: c, ...scored };
        }
      }
    }

    if (!best || best.confidence < 0.50) break;
    const row = rows[best.rowIndex];
    out.push({
      localKey: row.localKey,
      characterCode: best.candidate.code,
      name: best.candidate.name || characterName(best.candidate.code),
      confidence: Math.round(best.confidence * 100) / 100
    });
    unresolvedRows.delete(best.rowIndex);
    unusedCodes.delete(best.candidate.code);
  }

  return out;
}

function score(row, c) {
  const options = [];
  if (c.statsGames > 0) options.push(scoreAgainst(row, c, c.statsGames, c.statsWins, false));
  if (c.recentGames > 0) options.push(scoreAgainst(row, c, c.recentGames, c.recentWins, true));
  if (!options.length) return { cost: 999999, confidence: 0 };
  return options.sort((a, b) => (a.cost - b.cost) || (b.confidence - a.confidence))[0];
}

function scoreAgainst(row, c, games, wins, hasFingerprint) {
  const playDiff = Math.abs(row.play - games);
  const winDiff = Math.abs(row.win - wins);
  let cost = playDiff * 45 + winDiff * 90;
  let confidence = 0.30;

  if (playDiff === 0 && winDiff === 0) confidence = 0.84;
  else if (playDiff === 0 && winDiff <= 1) confidence = 0.72;
  else if (playDiff <= 1 && winDiff <= 1) confidence = 0.60;
  else if (playDiff <= Math.max(2, Math.ceil(row.play * 0.08)) && winDiff <= Math.max(1, Math.ceil(row.win * 0.15))) confidence = 0.51;

  if (hasFingerprint && c.recentGames === row.play) {
    const killDiff = Math.abs(row.playerKill - c.kills);
    const damageDiff = Math.abs(row.damageToPlayer - c.damage);
    const damageTolerance = Math.max(500, row.damageToPlayer * 0.015);
    cost += killDiff * 7 + Math.min(120, damageDiff / Math.max(250, damageTolerance / 6));
    if (killDiff === 0) confidence += 0.06;
    if (damageDiff <= damageTolerance) confidence += 0.09;
    if (killDiff === 0 && damageDiff <= damageTolerance) confidence = Math.max(confidence, 0.97);
  }

  return { cost, confidence: Math.min(0.99, confidence) };
}

function characterName(code) {
  return NAMES[String(code)] || `#${code}`;
}

function makeCacheKey(nickname, mode, seasonKey, rows) {
  return `${nickname.toLowerCase()}|${mode}|${seasonKey}|` + rows.map(r => `${r.localKey}:${r.play}:${r.win}:${Math.round(r.playerKill)}:${Math.round(r.damageToPlayer)}`).join(';');
}

function putCache(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  if (cache.size <= MAX_CACHE) return;
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

function isExpectedMissing(err) {
  return [400, 404].includes(Number(err?.status));
}
function toInt(v) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }


function consumeRate(req) {
  const raw = String(req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || 'unknown');
  const ip = raw.split(',')[0].trim();
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 36;
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 2000) {
    for (const [key, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(key);
  }
  return bucket.count <= maxRequests;
}
