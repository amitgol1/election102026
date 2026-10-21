import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import data from "../data/candidates.json";
import suggestions from "../data/suggestions.json";
import { handle, ipKey } from "../src/app.js";
import { ROLES } from "../src/roles.js";

const ORIGIN = "https://x.test";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const PASS_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const BAN_START = new Date(env.BAN_START);
const BAN_END = new Date(env.BAN_END);
const BEFORE_BAN = new Date(BAN_START.getTime() - 3_600_000);
const [partyA, partyB] = data.parties.map((p) => p.id);
const candidateIds = data.candidates.map((c) => c.id);

const makePicks = (shift = 0) =>
  Object.fromEntries(ROLES.map((r, i) => [r.id, candidateIds[(i + shift) % candidateIds.length]]));

let cache;
let siteverify;

const call = (method, path, { body, headers = {}, ip = "1.1.1.1", now = BEFORE_BAN, envOverrides = {} } = {}) =>
  handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: ORIGIN, "CF-Connecting-IP": ip, ...headers },
      body: body === undefined || typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body),
    }),
    { ...env, ...envOverrides },
    { now, cache },
  );

const vote = (overrides = {}, opts = {}) =>
  call("POST", "/api/vote", {
    body: {
      voterId: crypto.randomUUID(),
      partyId: partyA,
      picks: makePicks(),
      turnstileToken: PASS_TOKEN,
      ...overrides,
    },
    ...opts,
  });

const results = async (query = "", opts) => (await call("GET", `/api/results${query}`, opts)).json();

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

beforeEach(async () => {
  await env.DB.batch(
    ["picks", "votes", "tally", "ip_counts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  cache = await caches.open(crypto.randomUUID());
  siteverify = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(SITEVERIFY);
    const { secret, response } = JSON.parse(init.body);
    const success = secret === env.TURNSTILE_SECRET && response === PASS_TOKEN;
    return Response.json(success ? { success } : { success, "error-codes": ["invalid-input-response"] });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("GET /api/candidates", () => {
  it("returns parties, candidates, roles in fixed order and the Turnstile site key", async () => {
    const res = await call("GET", "/api/candidates");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parties).toEqual(data.parties);
    expect(body.candidates).toEqual(data.candidates);
    expect(body.roles.map((r) => r.id)).toEqual([
      "pm", "defense", "foreign", "finance", "justice", "transport", "education",
      "sports", "economy", "hasbara", "religion", "culture", "national_security",
    ]);
    expect(body.roles[0]).toEqual({ id: "pm", name: "ראש הממשלה" });
    expect(body.turnstileSiteKey).toBe(env.TURNSTILE_SITE_KEY);
    expect(body.suggestions).toEqual(suggestions.roles);
  });

  it("suggestions reference only known roles and candidates", () => {
    const roleIds = new Set(ROLES.map((r) => r.id));
    for (const [roleId, list] of Object.entries(suggestions.roles)) {
      expect(roleIds.has(roleId)).toBe(true);
      for (const s of list) {
        expect(data.candidates.some((c) => c.id === s.candidateId)).toBe(true);
        expect(typeof s.reason).toBe("string");
      }
    }
  });

  it("is reachable through the worker entrypoint", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/api/candidates`);
    expect(res.status).toBe(200);
    expect((await res.json()).roles).toHaveLength(13);
  });
});

describe("fail closed on bad config", () => {
  const cases = [
    ["missing BAN_START", { BAN_START: undefined }],
    ["invalid BAN_END", { BAN_END: "not-a-date" }],
    ["BAN_END before BAN_START", { BAN_END: "2020-01-01T00:00:00Z" }],
    ["missing IP_DAILY_LIMIT", { IP_DAILY_LIMIT: undefined }],
    ["non-numeric IP_DAILY_LIMIT", { IP_DAILY_LIMIT: "abc" }],
    ["zero IP_DAILY_LIMIT", { IP_DAILY_LIMIT: "0" }],
    ["missing IP_SALT", { IP_SALT: "" }],
    ["missing TURNSTILE_SECRET", { TURNSTILE_SECRET: undefined }],
  ];
  for (const [name, envOverrides] of cases) {
    it(`throws on ${name}`, async () => {
      await expect(call("GET", "/api/results", { envOverrides })).rejects.toThrow();
    });
  }

  it("the entrypoint turns a config error into 500", async () => {
    const { default: worker } = await import("../src/index.js");
    const bad = await worker.fetch(new Request(`${ORIGIN}/api/candidates`), { ...env, IP_SALT: "" });
    expect(bad.status).toBe(500);
  });
});

describe("POST /api/vote", () => {
  it("accepts a valid vote and verifies Turnstile with secret and remoteip", async () => {
    const res = await vote({}, { ip: "5.6.7.8" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(siteverify).toHaveBeenCalledTimes(1);
    expect(JSON.parse(siteverify.mock.calls[0][1].body)).toEqual({
      secret: env.TURNSTILE_SECRET,
      response: PASS_TOKEN,
      remoteip: "5.6.7.8",
    });
  });

  it("never stores the IP or anything linkable to it with the vote", async () => {
    await vote({}, { ip: "9.8.7.6" });
    const cols = (await env.DB.prepare("PRAGMA table_info(votes)").all()).results.map((c) => c.name);
    expect(cols.sort()).toEqual(["created_at", "party_id", "voter_id"]);
    const counter = await env.DB.prepare("SELECT key, n FROM ip_counts").first();
    expect(counter.key).toMatch(/^[0-9a-f]{64}$/);
    expect(counter.n).toBe(1);
  });

  describe("request guards", () => {
    it("rejects text/plain with 403", async () => {
      const res = await vote({}, { headers: { "content-type": "text/plain" } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    });

    it("rejects a cross-origin POST with 403", async () => {
      const res = await vote({}, { headers: { origin: "https://evil.test" } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    });

    it("rejects a POST without Origin with 403", async () => {
      const res = await vote({}, { headers: { origin: "" } });
      expect(res.status).toBe(403);
    });

    it("accepts application/json with a charset parameter", async () => {
      const res = await vote({}, { headers: { "content-type": "application/json; charset=utf-8" } });
      expect(res.status).toBe(201);
    });

    it("rejects a declared content-length over 4KB with 400", async () => {
      const res = await vote({}, { headers: { "content-length": "5000" } });
      expect(res.status).toBe(400);
    });

    it("rejects an actual body over 4KB with 400", async () => {
      const res = await vote({ padding: "x".repeat(5000) });
      expect(res.status).toBe(400);
      expect(siteverify).not.toHaveBeenCalled();
    });

    it("rejects a streamed body over 4KB without content-length with 400", async () => {
      const chunk = new TextEncoder().encode("x".repeat(1024));
      const stream = new ReadableStream({
        start(c) {
          for (let i = 0; i < 5; i++) c.enqueue(chunk);
          c.close();
        },
      });
      const res = await call("POST", "/api/vote", { body: stream });
      expect(res.status).toBe(400);
    });
  });

  const invalidCases = [
    ["bad uuid", { voterId: "not-a-uuid" }],
    ["non-v4 uuid", { voterId: "123e4567-e89b-12d3-a456-426614174000" }],
    ["unknown party", { partyId: "no-such-party" }],
    ["missing party", { partyId: undefined }],
    ["unknown candidate", { picks: { ...makePicks(), pm: "no-such-candidate" } }],
    ["missing role", { picks: (({ pm, ...rest }) => rest)(makePicks()) }],
    ["unknown role", { picks: { ...makePicks(), king: candidateIds[0] } }],
    ["duplicate candidate", { picks: { ...makePicks(), defense: makePicks().pm } }],
    ["picks not an object", { picks: [] }],
  ];
  for (const [name, overrides] of invalidCases) {
    it(`rejects ${name} with 400`, async () => {
      const res = await vote(overrides);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid" });
    });
  }

  it("rejects malformed JSON with 400", async () => {
    expect((await call("POST", "/api/vote", { body: "{" })).status).toBe(400);
  });

  it("returns 403 captcha when Turnstile fails", async () => {
    const res = await vote({ turnstileToken: "bad-token" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "captcha" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM votes").first()).n).toBe(0);
  });

  it("returns 403 captcha when the token is missing", async () => {
    const res = await vote({ turnstileToken: undefined });
    expect(res.status).toBe(403);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("returns 403 captcha when siteverify is unreachable", async () => {
    siteverify.mockRejectedValue(new Error("network"));
    expect((await vote()).status).toBe(403);
  });

  it("returns 409 on a second vote by the same voter", async () => {
    const voterId = crypto.randomUUID();
    expect((await vote({ voterId })).status).toBe(201);
    const res = await vote({ voterId: voterId.toUpperCase(), picks: makePicks(1) }, { ip: "2.2.2.2" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_voted" });
  });

  it("returns 409 rather than 429 for a returning voter over the IP limit", async () => {
    const envOverrides = { IP_DAILY_LIMIT: "1" };
    const voterId = crypto.randomUUID();
    expect((await vote({ voterId }, { envOverrides })).status).toBe(201);
    expect((await vote({ voterId }, { envOverrides })).status).toBe(409);
  });

  it("returns 429 above IP_DAILY_LIMIT per UTC day", async () => {
    const envOverrides = { IP_DAILY_LIMIT: "3" };
    for (let i = 0; i < 3; i++) expect((await vote({}, { ip: "3.3.3.3", envOverrides })).status).toBe(201);
    const res = await vote({}, { ip: "3.3.3.3", envOverrides });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect((await vote({}, { ip: "4.4.4.4", envOverrides })).status).toBe(201);
    const nextDay = new Date(BEFORE_BAN.getTime() + 86_400_000);
    expect((await vote({}, { ip: "3.3.3.3", now: nextDay, envOverrides })).status).toBe(201);
  });

  it("concurrent votes from one IP cannot exceed the limit", async () => {
    const envOverrides = { IP_DAILY_LIMIT: "3" };
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () => vote({}, { ip: "7.7.7.7", envOverrides }).then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM votes").first()).n).toBe(3);
  });

  it("counts IPv6 addresses per /64 prefix", async () => {
    const envOverrides = { IP_DAILY_LIMIT: "1" };
    expect((await vote({}, { ip: "2001:db8:1:2::1", envOverrides })).status).toBe(201);
    expect((await vote({}, { ip: "2001:db8:1:2:ffff::9", envOverrides })).status).toBe(429);
    expect((await vote({}, { ip: "2001:db8:1:3::1", envOverrides })).status).toBe(201);
  });

  it("deletes ip_counts rows from earlier days", async () => {
    await vote({}, { ip: "8.8.8.8" });
    await vote({}, { ip: "8.8.4.4", now: new Date(BEFORE_BAN.getTime() + 86_400_000) });
    const { results: rows } = await env.DB.prepare("SELECT day FROM ip_counts").all();
    expect(rows).toHaveLength(1);
  });
});

describe("ipKey", () => {
  it.each([
    ["1.2.3.4", "1.2.3.4"],
    ["::ffff:1.2.3.4", "1.2.3.4"],
    ["2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    [null, "unknown"],
  ])("%s → %s", (ip, key) => expect(ipKey(ip)).toBe(key));
});

describe("GET /api/status", () => {
  it("reports not voted", async () => {
    const res = await call("GET", `/api/status?voterId=${crypto.randomUUID()}`);
    expect(await res.json()).toEqual({ voted: false });
  });

  it("returns party and picks after voting", async () => {
    const voterId = crypto.randomUUID();
    await vote({ voterId, partyId: partyB, picks: makePicks(2) });
    const res = await call("GET", `/api/status?voterId=${voterId}`);
    expect(await res.json()).toEqual({ voted: true, partyId: partyB, picks: makePicks(2) });
  });

  it("rejects a bad voterId with 400", async () => {
    expect((await call("GET", "/api/status?voterId=nope")).status).toBe(400);
  });
});

describe("GET /api/results", () => {
  const seed = async (now = BEFORE_BAN) => {
    await vote({ partyId: partyA, picks: makePicks(0) }, { now });
    await vote({ partyId: partyA, picks: makePicks(0) }, { now });
    await vote({ partyId: partyB, picks: makePicks(1) }, { now });
  };

  it("returns empty roles with no votes", async () => {
    const body = await results();
    expect(body).toMatchObject({ total: 0, banned: false, ties: [] });
    expect(Object.keys(body.byRole)).toEqual(ROLES.map((r) => r.id));
    expect(body.byRole.pm).toEqual([]);
  });

  it("aggregates counts and pct with one decimal", async () => {
    await seed();
    const body = await results();
    expect(body.total).toBe(3);
    expect(body.banned).toBe(false);
    expect(body.ties).toEqual([]);
    expect(body.byRole.pm).toEqual([
      { candidateId: makePicks(0).pm, pct: 66.7, count: 2 },
      { candidateId: makePicks(1).pm, pct: 33.3, count: 1 },
    ]);
  });

  it("rounds pct as Math.round(count*1000/total)/10", async () => {
    for (let i = 0; i < 8; i++) await vote({ picks: makePicks(i < 7 ? 0 : 1) });
    const body = await results();
    expect(body.byRole.pm).toEqual([
      { candidateId: makePicks(0).pm, pct: 87.5, count: 7 },
      { candidateId: makePicks(1).pm, pct: 12.5, count: 1 },
    ]);
  });

  it("returns at most top 3 per role, ordered by count", async () => {
    for (let i = 0; i < 4; i++) await vote({ picks: makePicks(i) });
    await vote({ picks: makePicks(3) });
    const body = await results();
    expect(body.byRole.pm).toHaveLength(3);
    expect(body.byRole.pm[0]).toEqual({ candidateId: makePicks(3).pm, pct: 40, count: 2 });
  });

  it("flags roles whose top two counts are equal", async () => {
    await vote({ picks: makePicks(0) });
    await vote({ picks: makePicks(1) });
    const body = await results();
    expect(body.ties).toEqual(ROLES.map((r) => r.id));
    await vote({ picks: makePicks(0) }, { now: new Date(BEFORE_BAN.getTime() + 31_000) });
    const later = await results("", { now: new Date(BEFORE_BAN.getTime() + 31_000) });
    expect(later.ties).toEqual([]);
  });

  it("reads results from the tally table only", async () => {
    await seed();
    await env.DB.batch([env.DB.prepare("DELETE FROM picks"), env.DB.prepare("DELETE FROM votes")]);
    expect((await results()).total).toBe(3);
  });

  it("filters by party", async () => {
    await seed();
    const body = await results(`?party=${partyB}`);
    expect(body.total).toBe(1);
    expect(body.byRole.pm).toEqual([{ candidateId: makePicks(1).pm, pct: 100, count: 1 }]);
  });

  it("rejects an unknown party with 400", async () => {
    expect((await call("GET", "/api/results?party=no-such-party")).status).toBe(400);
  });

  describe("ban window", () => {
    it("hides party breakdown", async () => {
      await seed();
      expect(await results(`?party=${partyA}`, { now: BAN_START })).toEqual({ banned: true });
    });

    it("returns pct only for all voters, with ties computed from counts", async () => {
      await seed();
      await vote({ partyId: partyB, picks: makePicks(1) });
      const body = await results("", { now: BAN_START });
      expect(body.banned).toBe(true);
      expect(body).not.toHaveProperty("total");
      expect(body.ties).toEqual(ROLES.map((r) => r.id));
      expect(body.byRole.pm).toEqual([
        { candidateId: makePicks(0).pm, pct: 50 },
        { candidateId: makePicks(1).pm, pct: 50 },
      ]);
    });

    it("is still banned at the last ms before BAN_END", async () => {
      const now = new Date(BAN_END.getTime() - 1);
      expect(await results(`?party=${partyA}`, { now })).toEqual({ banned: true });
    });

    it("ends at BAN_END", async () => {
      await seed();
      const body = await results(`?party=${partyA}`, { now: BAN_END });
      expect(body.banned).toBe(false);
      expect(body.total).toBe(2);
    });
  });

  describe("caching", () => {
    it("serves a cached response for 30s, then recomputes", async () => {
      await seed();
      expect((await results()).total).toBe(3);
      await vote();
      expect((await results("", { now: new Date(BEFORE_BAN.getTime() + 29_999) })).total).toBe(3);
      expect((await results("", { now: new Date(BEFORE_BAN.getTime() + 30_000) })).total).toBe(4);
    });

    it("keys the cache by party", async () => {
      await seed();
      expect((await results()).total).toBe(3);
      expect((await results(`?party=${partyB}`)).total).toBe(1);
    });

    it("never serves a pre-ban response at or after BAN_START", async () => {
      await seed();
      const fiveBefore = new Date(BAN_START.getTime() - 5_500);
      expect((await results("", { now: fiveBefore })).banned).toBe(false);
      const stored = await cache.match(`${ORIGIN}/api/results?party=&banned=0`);
      expect(stored.headers.get("cache-control")).toBe("max-age=5");
      expect(stored.headers.get("x-expires-at")).toBe(String(BAN_START.getTime()));

      await vote();
      expect((await results("", { now: new Date(BAN_START.getTime() - 1) })).total).toBe(3);
      const atBan = await results("", { now: BAN_START });
      expect(atBan.banned).toBe(true);
      expect(atBan).not.toHaveProperty("total");
      expect(atBan.byRole.pm[0].pct).toBe(75);
      const party = await results(`?party=${partyA}`, { now: new Date(BAN_START.getTime() - 1) });
      expect(party.banned).toBe(false);
      expect(await results(`?party=${partyA}`, { now: BAN_START })).toEqual({ banned: true });
    });

    it("never serves a banned response at or after BAN_END", async () => {
      await seed();
      const before = new Date(BAN_END.getTime() - 10_000);
      expect((await results("", { now: before })).banned).toBe(true);
      const stored = await cache.match(`${ORIGIN}/api/results?party=&banned=1`);
      expect(stored.headers.get("cache-control")).toBe("max-age=10");
      expect(stored.headers.get("x-expires-at")).toBe(String(BAN_END.getTime()));
      const after = await results("", { now: BAN_END });
      expect(after.banned).toBe(false);
      expect(after.total).toBe(3);
    });

    it("does not cache when under 1s remains before a boundary", async () => {
      await results("", { now: new Date(BAN_START.getTime() - 500) });
      expect(await cache.match(`${ORIGIN}/api/results?party=&banned=0`)).toBeUndefined();
    });
  });
});

it("returns 404 for unknown api routes", async () => {
  expect((await call("GET", "/api/nope")).status).toBe(404);
});
