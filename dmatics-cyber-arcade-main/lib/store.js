// Leaderboard storage.
//
//  • A Redis-compatible database is used when one is attached, giving a single
//    shared board that survives redeploys and is identical on every device.
//  • Otherwise the board lives in serverless memory: it works, but each instance
//    has its own copy and everything is lost on redeploy. The client is told
//    which of the two is in play (`persistent`) so the UI can say so honestly.
//
// Detection deliberately does a real round-trip rather than trusting environment
// variables. Env vars can be present while the client still fails to connect —
// which looks exactly like "the database is attached but nothing saves".

const GAMES = ['phish', 'soc', 'breach'];
const MAX = 10;
const KEEP = 200;          // raw entries retained per game before trimming
const LIST = 'scores:';    // append-only list key prefix

// ---- in-memory fallback (module scope) ----
const mem = { phish: [], soc: [], breach: [] };

// One row per player, keeping their personal best. The raw append-only list keeps
// every attempt (useful afterwards); the board the arcade shows is collapsed, so a
// visitor who plays five times occupies one line, not five.
function sortTrim(list) {
  const best = new Map();
  list
    .filter((e) => e && typeof e.s === 'number' && typeof e.n === 'string')
    .forEach((e) => {
      const k = e.n.toUpperCase();
      const cur = best.get(k);
      if (!cur || e.s > cur.s) best.set(k, e);
    });
  return [...best.values()].sort((a, b) => b.s - a.s).slice(0, MAX);
}

// Every env-var shape a Vercel / Upstash / Redis integration might inject.
//
// Upstash's Vercel integration PREFIXES every variable with the store name, e.g.
// `dmatics_arcade_KV_REST_API_URL`. Matching exact names therefore finds nothing
// and the app silently falls back to memory — so we match on the SUFFIX and pair
// variables by their shared prefix. The read-only token is never used for writes.
function findBySuffix(suffix) {
  const hit = Object.keys(process.env).find(
    (k) => k.toUpperCase().endsWith(suffix) && !k.toUpperCase().includes('READ_ONLY') && process.env[k]
  );
  return hit ? { key: hit, prefix: hit.slice(0, hit.length - suffix.length), value: process.env[hit] } : null;
}

// Returns every usable credential set, best transport first. Returning a LIST
// (not one winner) matters: if REST credentials exist but the endpoint refuses,
// we can still fall back to the TCP URL instead of silently dropping to memory.
function candidates() {
  const out = [];
  for (const [urlSuffix, tokenSuffix, kind] of [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'vercel-kv'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'upstash-rest'],
  ]) {
    const url = findBySuffix(urlSuffix);
    if (!url) continue;
    const exact = process.env[url.prefix + tokenSuffix];
    const token = exact || (findBySuffix(tokenSuffix) || {}).value;
    if (token) out.push({ kind, url: url.value, token, via: url.key });
  }
  const tcp = findBySuffix('REDIS_URL') || findBySuffix('KV_URL');
  if (tcp) out.push({ kind: 'redis-tcp', url: tcp.value, via: tcp.key });
  return out;
}

function credentials() {
  return candidates()[0] || null;
}

let clientPromise = null;   // cached across invocations on a warm instance

async function connect(cred) {
  if (!cred) return null;

  if (cred.kind === 'redis-tcp') {
    const { createClient } = await import('redis');
    const c = createClient({ url: cred.url });
    c.on('error', () => {});
    if (!c.isOpen) await c.connect();
    return {
      kind: cred.kind,
      lpush: (k, v) => c.lPush(k, v),
      ltrim: (k, a, b) => c.lTrim(k, a, b),
      lrange: (k, a, b) => c.lRange(k, a, b),
      get: async (k) => { const v = await c.get(k); return v ? JSON.parse(v) : null; },
      del: (k) => c.del(k),
      ping: () => c.ping(),
    };
  }

  const { createClient } = await import('@vercel/kv');
  const kv = createClient({ url: cred.url, token: cred.token });
  return {
    kind: cred.kind,
    lpush: (k, v) => kv.lpush(k, v),
    ltrim: (k, a, b) => kv.ltrim(k, a, b),
    lrange: (k, a, b) => kv.lrange(k, a, b),
    get: (k) => kv.get(k),
    del: (k) => kv.del(k),
    ping: () => kv.ping(),
  };
}

async function openFirstWorking() {
  for (const cred of candidates()) {
    try {
      const c = await connect(cred);
      if (!c) continue;
      await c.ping();                    // must actually answer, not just construct
      return c;
    } catch (e) { /* try the next transport */ }
  }
  return null;
}

async function db() {
  if (!candidates().length) return null;
  if (!clientPromise) clientPromise = openFirstWorking().catch(() => null);
  const c = await clientPromise;
  if (!c) clientPromise = null;          // allow a retry on the next request
  return c;
}

// True only when a real client exists AND answered. This is what the badge shows.
async function isPersistent() {
  const c = await db();
  if (!c) return false;
  try {
    await c.ping();
    return true;
  } catch (e) {
    return false;
  }
}

function safeParse(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

// Reads the append-only list plus any board left by the older blob format, so an
// upgrade never loses scores that are already stored.
async function readAll(c, game) {
  const [list, legacy] = await Promise.all([
    c.lrange(LIST + game, 0, KEEP - 1).catch(() => []),
    c.get('board:' + game).catch(() => null),
  ]);
  return []
    .concat(Array.isArray(list) ? list.map(safeParse) : [])
    .concat(Array.isArray(legacy) ? legacy : []);
}

export async function getScores(game) {
  if (!GAMES.includes(game)) return [];
  const c = await db();
  if (c) {
    try { return sortTrim(await readAll(c, game)); } catch (e) { /* fall through */ }
  }
  return sortTrim(mem[game] || []);
}

export async function addScore(game, name, score) {
  if (!GAMES.includes(game)) return [];
  const entry = { n: name, s: score, t: Date.now() };
  const c = await db();
  if (c) {
    try {
      // LPUSH is atomic, so two kiosks saving at the same moment cannot overwrite
      // each other the way a read-modify-write of a whole board would.
      await c.lpush(LIST + game, JSON.stringify(entry));
      await c.ltrim(LIST + game, 0, KEEP - 1).catch(() => {});
      return sortTrim(await readAll(c, game));
    } catch (e) { /* fall through */ }
  }
  mem[game] = sortTrim((mem[game] || []).concat(entry));
  return mem[game];
}

// Diagnostics for /api/health — reports NAMES of env vars only, never values.
export async function diagnose() {
  const cred = credentials();
  const SUFFIXES = [
    'KV_REST_API_URL', 'KV_REST_API_TOKEN',
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'REDIS_URL', 'KV_URL',
  ];
  // Names only — never values.
  const present = Object.keys(process.env).filter((k) =>
    SUFFIXES.some((s) => k.toUpperCase().endsWith(s)) && process.env[k]
  );
  const out = {
    provider: cred ? cred.kind : null,
    usingVariable: cred ? cred.via : null,
    transportsAvailable: candidates().map((c) => c.kind),
    envVarsPresent: present,
    connected: false,
    roundTrip: false,
    error: null,
  };
  if (!cred) {
    out.error = present.length
      ? 'Database variables exist but none could be paired into a usable set.'
      : 'No database environment variables found — attach a store in Vercel, then redeploy.';
    return out;
  }
  try {
    const c = await db();
    if (!c) { out.error = 'Credentials present but the client could not be created.'; return out; }
    out.connected = true;
    out.provider = c.kind;               // the transport that actually answered
    await c.ping();
    const probe = '__health:' + Date.now();
    await c.lpush(probe, JSON.stringify({ ok: 1 }));
    const back = await c.lrange(probe, 0, 0);
    out.roundTrip = Array.isArray(back) && back.length === 1;
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 200);
  }
  return out;
}

// Wipes every board — the shared database when one is attached, and always the
// in-memory copy. Used by the admin reset so the booth can start a clean day.
export async function clearAll() {
  GAMES.forEach((g) => { mem[g] = []; });
  const c = await db();
  if (!c) return { cleared: 'memory' };
  await Promise.all(
    GAMES.flatMap((g) => [
      c.del(LIST + g).catch(() => {}),
      c.del('board:' + g).catch(() => {}),
    ])
  );
  return { cleared: 'database' };
}

export { GAMES, isPersistent };
