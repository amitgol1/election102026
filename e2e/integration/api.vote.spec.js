import { test, expect } from '@playwright/test';
import { picksAt, apiVote, apiGet, freshIp, url, uuid, voteHeaders, ROLE_IDS } from './helpers.js';
import { IP_DAILY_LIMIT, DUMMY_TOKEN } from './env.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const post = (request, body, headers = voteHeaders('normal')) =>
  request.post(url('normal', '/api/vote'), { data: typeof body === 'string' ? body : JSON.stringify(body), headers });
const validBody = () => ({ voterId: uuid(), partyId: 'likud', picks: picksAt(0), turnstileToken: DUMMY_TOKEN });

test('second vote with same voterId is 409, also from another IP and in uppercase', async ({ request }) => {
  const first = await apiVote(request, 'normal');
  expect(first.status).toBe(201);
  expect(first.body).toEqual({ ok: true });
  expect(await apiVote(request, 'normal', { voterId: first.voterId, picks: picksAt(3) })).toMatchObject({ status: 409, body: { error: 'already_voted' } });
  expect((await apiVote(request, 'normal', { voterId: first.voterId.toUpperCase() })).status).toBe(409);
  const st = await apiGet(request, 'normal', `/api/status?voterId=${first.voterId.toUpperCase()}`);
  expect(st.body).toEqual({ voted: true, partyId: 'likud', picks: picksAt(0) });
});

test(`IP limit: ${IP_DAILY_LIMIT} votes per IP, then 429; other IPs unaffected; limited voter can vote elsewhere`, async ({ request }) => {
  const ip = freshIp();
  for (let i = 0; i < IP_DAILY_LIMIT; i++) expect((await apiVote(request, 'normal', { ip })).status).toBe(201);
  const blocked = await apiVote(request, 'normal', { ip });
  expect(blocked).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  expect((await apiGet(request, 'normal', `/api/status?voterId=${blocked.voterId}`)).body).toEqual({ voted: false });
  expect((await apiVote(request, 'normal', { voterId: blocked.voterId, ip: freshIp() })).status).toBe(201);
});

test('concurrent burst of 12 from one IP never exceeds the limit', async ({ request }) => {
  const ip = freshIp();
  const res = await Promise.all(Array.from({ length: 12 }, () => apiVote(request, 'normal', { ip })));
  const codes = res.map((r) => r.status).sort();
  expect(codes.filter((c) => c === 201)).toHaveLength(IP_DAILY_LIMIT);
  expect(codes.filter((c) => c === 429)).toHaveLength(12 - IP_DAILY_LIMIT);
});

test('IPv6: addresses in the same /64 share one limit; IPv4-mapped IPv6 equals IPv4', async ({ request }) => {
  const n = Math.floor(Math.random() * 0xffff).toString(16);
  const v6 = [`2001:db8:${n}:1::1`, `2001:DB8:${n}:1:ffff::2`, `2001:db8:${n}:1:0:0:0:3`];
  for (const ip of v6) expect((await apiVote(request, 'normal', { ip })).status, ip).toBe(201);
  expect((await apiVote(request, 'normal', { ip: `2001:db8:${n}:1:abcd::9` })).status).toBe(429);
  expect((await apiVote(request, 'normal', { ip: `2001:db8:${n}:2::1` })).status).toBe(201);

  const v4 = `10.250.${Math.floor(Math.random() * 250)}.7`;
  for (let i = 0; i < IP_DAILY_LIMIT; i++) expect((await apiVote(request, 'normal', { ip: v4 })).status).toBe(201);
  expect((await apiVote(request, 'normal', { ip: `::ffff:${v4}` })).status).toBe(429);
});

test('cross-origin Origin → 403 forbidden', async ({ request }) => {
  for (const origin of ['https://evil.example', 'http://127.0.0.1:8788', 'null', 'http://localhost:8788/']) {
    const res = await post(request, validBody(), { ...voteHeaders('normal'), origin });
    expect(res.status(), origin).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  }
});

test('missing Origin → 403 forbidden', async ({ request }) => {
  const { origin, ...headers } = voteHeaders('normal');
  expect((await post(request, validBody(), headers)).status()).toBe(403);
});

test('non-JSON Content-Type → 403 forbidden; JSON with charset/uppercase accepted', async ({ request }) => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const res = await post(request, validBody(), { ...voteHeaders('normal'), 'content-type': ct });
    expect(res.status(), ct).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  }
  for (const ct of ['application/json; charset=utf-8', 'Application/JSON']) {
    expect((await post(request, validBody(), { ...voteHeaders('normal'), 'content-type': ct })).status(), ct).toBe(201);
  }
});

test('body over 4KB → 400 (with Content-Length); exactly-at-limit valid vote accepted', async ({ request }) => {
  const big = { ...validBody(), pad: 'x'.repeat(4097) };
  const res = await post(request, big);
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: 'invalid' });
  expect((await apiGet(request, 'normal', `/api/status?voterId=${big.voterId}`)).body).toEqual({ voted: false });

  const exact = validBody();
  exact.pad = '';
  exact.pad = 'x'.repeat(4096 - Buffer.byteLength(JSON.stringify(exact)));
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(4096);
  expect((await post(request, exact)).status()).toBe(201);
});

test('body over 4KB sent chunked (no Content-Length) → 400', async () => {
  const body = JSON.stringify({ ...validBody(), pad: 'x'.repeat(8000) });
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } });
  const res = await fetch(url('normal', '/api/vote'), { method: 'POST', headers: voteHeaders('normal'), body: stream, duplex: 'half' });
  expect(res.status).toBe(400);
});

for (const [name, token] of [['missing', undefined], ['empty', ''], ['number', 123], ['2049 chars', 'x'.repeat(2049)]]) {
  test(`turnstileToken ${name} → 403 captcha, vote not stored`, async ({ request }) => {
    const body = { ...validBody(), turnstileToken: token };
    const res = await post(request, body);
    expect(res.status()).toBe(403);
    expect(await res.json()).toEqual({ error: 'captcha' });
    expect((await apiGet(request, 'normal', `/api/status?voterId=${body.voterId}`)).body).toEqual({ voted: false });
  });
}

const bad = (mut) => { const b = validBody(); mut(b); return b; };
const INVALID = {
  'duplicate candidate': bad((b) => { b.picks.national_security = b.picks.pm; }),
  '11 roles': bad((b) => { delete b.picks.culture; }),
  'extra unknown role': bad((b) => { b.picks.king = 'dems-4'; }),
  'unknown role replacing a real one': bad((b) => { delete b.picks.culture; b.picks.king = 'dems-4'; }),
  'candidate id wrong case': bad((b) => { b.picks.pm = b.picks.pm.toUpperCase(); }),
  'candidate id zero-padded': bad((b) => { b.picks.pm = b.picks.pm.replace(/-(\d)$/, '-0$1'); }),
  'candidate id number': bad((b) => { b.picks.pm = 1; }),
  'candidate id null': bad((b) => { b.picks.pm = null; }),
  'picks as array': bad((b) => { b.picks = ROLE_IDS.map((r) => b.picks[r]); }),
  'unknown party': bad((b) => { b.partyId = 'nope'; }),
  'party prototype key': bad((b) => { b.partyId = 'constructor'; }),
  'non-v4 uuid': bad((b) => { b.voterId = '11111111-1111-1111-8111-111111111111'; }),
  'uuid with whitespace': bad((b) => { b.voterId = ` ${b.voterId}`; }),
  'SQL in voterId': bad((b) => { b.voterId = "x' OR 1=1; --"; }),
  'SQL in partyId': bad((b) => { b.partyId = "likud'; DROP TABLE votes; --"; }),
  'SQL in candidate': bad((b) => { b.picks.pm = "likud-1' OR '1'='1"; }),
  'XSS in candidate': bad((b) => { b.picks.pm = '<img src=x onerror=alert(1)>'; }),
  'XSS in partyId': bad((b) => { b.partyId = '<script>alert(1)</script>'; }),
};

for (const [name, body] of Object.entries(INVALID)) {
  test(`400 invalid: ${name}`, async ({ request }) => {
    const res = await post(request, body);
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid' });
    if (typeof body.voterId === 'string' && UUID_V4.test(body.voterId)) {
      expect((await apiGet(request, 'normal', `/api/status?voterId=${body.voterId}`)).body).toEqual({ voted: false });
    }
  });
}

for (const [name, raw] of Object.entries({ 'malformed JSON': '{"voterId":', 'empty body': '', 'JSON null': 'null', 'JSON array': '[]', 'JSON string': '"x"' })) {
  test(`400 invalid: ${name}`, async ({ request }) => {
    expect((await post(request, raw)).status()).toBe(400);
  });
}

test('SQL-ish probes leave tables intact', async ({ request }) => {
  expect((await apiGet(request, 'normal', "/api/status?voterId=x'%20OR%201=1--")).status).toBe(400);
  expect((await apiGet(request, 'normal', "/api/results?party=likud'%20OR%201=1--")).status).toBe(400);
  expect((await apiGet(request, 'normal', '/api/results')).status).toBe(200);
  expect((await apiVote(request, 'normal')).status).toBe(201);
});

test('missing CF-Connecting-IP still accepts a vote', async ({ request }) => {
  expect((await apiVote(request, 'normal', { ip: null })).status).toBe(201);
});

for (const [method, path] of [['GET', '/api/vote'], ['PUT', '/api/vote'], ['DELETE', '/api/vote'], ['PATCH', '/api/vote'], ['POST', '/api/results'], ['POST', '/api/status'], ['DELETE', '/api/results']]) {
  test(`${method} ${path} → 404`, async ({ request }) => {
    const res = await request.fetch(url('normal', path), { method, data: method === 'GET' ? undefined : JSON.stringify(validBody()), headers: voteHeaders('normal') });
    expect(res.status()).toBe(404);
  });
}

test('results party param validation', async ({ request }) => {
  for (const p of ['__proto__', '', 'LIKUD', '<script>']) {
    expect((await apiGet(request, 'normal', `/api/results?party=${encodeURIComponent(p)}`)).status, p).toBe(400);
  }
});

test('API never returns raw IP or an IP hash', async ({ request }) => {
  const ip = '203.0.113.77';
  const v = await apiVote(request, 'normal', { ip });
  expect(v.status).toBe(201);
  const texts = [
    JSON.stringify(v.body),
    JSON.stringify((await apiGet(request, 'normal', `/api/status?voterId=${v.voterId}`)).body),
    JSON.stringify((await apiGet(request, 'normal', '/api/results')).body),
    JSON.stringify((await apiGet(request, 'normal', '/api/results?party=likud')).body),
  ];
  for (const t of texts) expect(t).not.toMatch(/203\.0\.113|ip_hash|ipHash|[0-9a-f]{64}/);
});

test('candidates exposes the Turnstile site key', async ({ request }) => {
  const { body } = await apiGet(request, 'normal', '/api/candidates');
  expect(body.turnstileSiteKey).toBe('1x00000000000000000000AA');
});
