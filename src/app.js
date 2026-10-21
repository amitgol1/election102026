import data from "../data/candidates.json";
import suggestions from "../data/suggestions.json";
import { ROLES } from "./roles.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARTY_IDS = new Set(data.parties.map((p) => p.id));
const CANDIDATE_IDS = new Set(data.candidates.map((c) => c.id));
const ROLE_IDS = ROLES.map((r) => r.id);
const MAX_BODY = 4096;
const RESULTS_TTL_MS = 30_000;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const invalid = () => json({ error: "invalid" }, 400);
const forbidden = () => json({ error: "forbidden" }, 403);

function config(env) {
  const banStart = Date.parse(env.BAN_START);
  const banEnd = Date.parse(env.BAN_END);
  const limit = Number(env.IP_DAILY_LIMIT);
  if (!Number.isFinite(banStart) || !Number.isFinite(banEnd) || banStart >= banEnd) {
    throw new Error("BAN_START/BAN_END missing or invalid");
  }
  if (!Number.isInteger(limit) || limit < 1) throw new Error("IP_DAILY_LIMIT missing or invalid");
  if (!env.IP_SALT) throw new Error("IP_SALT missing");
  if (!env.TURNSTILE_SECRET) throw new Error("TURNSTILE_SECRET missing");
  return { banStart, banEnd, limit };
}

export async function handle(request, env, { now = new Date(), cache = caches.default } = {}) {
  const cfg = config(env);
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /api/candidates") return candidates(env);
  if (route === "POST /api/vote") return vote(request, url, env, cfg, now);
  if (route === "GET /api/results") return results(url, env, cfg, now, cache);
  if (route === "GET /api/status") return status(url, env);
  return json({ error: "not_found" }, 404);
}

function candidates(env) {
  return json({
    parties: data.parties,
    candidates: data.candidates,
    roles: ROLES,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
    suggestions: suggestions.roles,
  });
}

function isValidVote(body) {
  if (!body || typeof body !== "object") return false;
  const { voterId, partyId, picks } = body;
  if (typeof voterId !== "string" || !UUID_V4.test(voterId)) return false;
  if (!PARTY_IDS.has(partyId)) return false;
  if (!picks || typeof picks !== "object" || Array.isArray(picks)) return false;
  const keys = Object.keys(picks);
  if (keys.length !== ROLE_IDS.length || !ROLE_IDS.every((id) => Object.hasOwn(picks, id))) return false;
  const values = ROLE_IDS.map((id) => picks[id]);
  if (!values.every((v) => CANDIDATE_IDS.has(v))) return false;
  return new Set(values).size === values.length;
}

async function readCapped(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function verifyTurnstile(token, ip, env) {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, ...(ip && { remoteip: ip }) }),
    });
    if (!res.ok) return false;
    return (await res.json()).success === true;
  } catch {
    return false;
  }
}

export function ipKey(ip) {
  if (!ip) return "unknown";
  ip = ip.trim().toLowerCase().split("%")[0];
  if (!ip.includes(":")) return ip;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const zeros = ip.includes("::") ? Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill("0") : [];
  const groups = [...headParts, ...zeros, ...tailParts];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function vote(request, url, env, cfg, now) {
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return forbidden();
  if (request.headers.get("origin") !== url.origin) return forbidden();

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return invalid();
  const text = await readCapped(request);
  if (text === null) return invalid();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!isValidVote(body)) return invalid();

  const ip = request.headers.get("CF-Connecting-IP");
  if (!(await verifyTurnstile(body.turnstileToken, ip, env))) return json({ error: "captcha" }, 403);

  const voterId = body.voterId.toLowerCase();
  const existing = await env.DB.prepare("SELECT 1 FROM votes WHERE voter_id = ?").bind(voterId).first();
  if (existing) return json({ error: "already_voted" }, 409);

  const day = now.toISOString().slice(0, 10);
  const key = await hmacHex(env.IP_SALT, `${ipKey(ip)}|${day}`);
  const { n } = await env.DB.prepare(
    "INSERT INTO ip_counts (key, day, n) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET n = n + 1 RETURNING n",
  )
    .bind(key, day)
    .first();
  if (n > cfg.limit) return json({ error: "rate_limited" }, 429);

  const insertPick = env.DB.prepare(
    "INSERT INTO picks (voter_id, party_id, role_id, candidate_id) VALUES (?, ?, ?, ?)",
  );
  const upsertTally = env.DB.prepare(
    "INSERT INTO tally (party_id, role_id, candidate_id, n) VALUES (?, ?, ?, 1) " +
      "ON CONFLICT (party_id, role_id, candidate_id) DO UPDATE SET n = n + 1",
  );
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO votes (voter_id, party_id, created_at) VALUES (?, ?, ?)").bind(
        voterId,
        body.partyId,
        now.toISOString(),
      ),
      ...ROLE_IDS.map((roleId) => insertPick.bind(voterId, body.partyId, roleId, body.picks[roleId])),
      ...ROLE_IDS.map((roleId) => upsertTally.bind(body.partyId, roleId, body.picks[roleId])),
      env.DB.prepare("DELETE FROM ip_counts WHERE day < ?").bind(day),
    ]);
  } catch (e) {
    if (String(e?.message).includes("UNIQUE constraint failed")) return json({ error: "already_voted" }, 409);
    throw e;
  }
  return json({ ok: true }, 201);
}

async function computeResults(env, party, banned) {
  const totalSql = `SELECT COALESCE(SUM(n), 0) AS total FROM tally WHERE role_id = ?1${party !== null ? " AND party_id = ?2" : ""}`;
  const topSql = `SELECT role_id, candidate_id, count FROM (
       SELECT role_id, candidate_id, SUM(n) AS count,
              ROW_NUMBER() OVER (PARTITION BY role_id ORDER BY SUM(n) DESC, candidate_id) AS rn
       FROM tally ${party !== null ? "WHERE party_id = ?1" : ""}
       GROUP BY role_id, candidate_id
     ) WHERE rn <= 3 ORDER BY role_id, rn`;
  const partyParams = party !== null ? [party] : [];
  const [totalRes, topRes] = await env.DB.batch([
    env.DB.prepare(totalSql).bind(ROLE_IDS[0], ...partyParams),
    env.DB.prepare(topSql).bind(...partyParams),
  ]);
  const total = totalRes.results[0].total;
  const byRole = Object.fromEntries(ROLE_IDS.map((id) => [id, []]));
  for (const row of topRes.results) {
    const pct = Math.round((row.count * 1000) / total) / 10;
    byRole[row.role_id].push({ candidateId: row.candidate_id, pct, count: row.count });
  }
  const ties = ROLE_IDS.filter((id) => byRole[id].length >= 2 && byRole[id][0].count === byRole[id][1].count);
  if (!banned) return { total, banned, byRole, ties };
  for (const id of ROLE_IDS) byRole[id] = byRole[id].map(({ candidateId, pct }) => ({ candidateId, pct }));
  return { banned, byRole, ties };
}

async function results(url, env, cfg, now, cache) {
  const party = url.searchParams.get("party");
  if (party !== null && !PARTY_IDS.has(party)) return invalid();
  const t = now.getTime();
  const banned = cfg.banStart <= t && t < cfg.banEnd;
  if (banned && party !== null) return json({ banned: true });

  const key = new Request(`${url.origin}/api/results?party=${encodeURIComponent(party ?? "")}&banned=${banned ? 1 : 0}`);
  const cached = await cache.match(key);
  if (cached && t < Number(cached.headers.get("x-expires-at"))) return json(await cached.json());

  const body = await computeResults(env, party, banned);
  const boundary = banned ? cfg.banEnd : t < cfg.banStart ? cfg.banStart : Infinity;
  const ttlMs = Math.min(RESULTS_TTL_MS, boundary - t);
  const maxAge = Math.floor(ttlMs / 1000);
  if (maxAge >= 1) {
    await cache.put(
      key,
      new Response(JSON.stringify(body), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${maxAge}`,
          "x-expires-at": String(t + ttlMs),
        },
      }),
    );
  }
  return json(body);
}

async function status(url, env) {
  const voterId = url.searchParams.get("voterId");
  if (!voterId || !UUID_V4.test(voterId)) return invalid();
  const { results: rows } = await env.DB.prepare(
    "SELECT party_id, role_id, candidate_id FROM picks WHERE voter_id = ?",
  )
    .bind(voterId.toLowerCase())
    .all();
  if (rows.length === 0) return json({ voted: false });
  return json({
    voted: true,
    partyId: rows[0].party_id,
    picks: Object.fromEntries(rows.map((r) => [r.role_id, r.candidate_id])),
  });
}
