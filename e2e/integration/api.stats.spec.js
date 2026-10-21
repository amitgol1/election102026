import { test, expect } from '@playwright/test';
import { ROLE_IDS, data, picksAt, apiVote, apiGet } from './helpers.js';

// Dedicated "stats" server with its own empty D1, so exact numbers are deterministic.
// /api/results is cached up to 30s, so reads after a later vote poll instead of expecting it at once.
test.describe.configure({ mode: 'serial' });

const ids = data.candidates.map((c) => c.id);
const OFFSET = { likud: 0, yashar: 6, dems: 12 };
const VOTERS = { likud: 4, yashar: 2, dems: 1 };
const top = (party, i) => ids[(OFFSET[party] + i) % ids.length];
const CACHE_MS = 30_000;
const fresh = (request, path, until) =>
  expect.poll(async () => (await apiGet(request, 'stats', path)).body, { timeout: CACHE_MS + 10_000, intervals: [1000] }).toEqual(until);

test('roles in API match helper order', async ({ request }) => {
  const { body } = await apiGet(request, 'stats', '/api/candidates');
  expect(body.roles.map((r) => r.id)).toEqual(ROLE_IDS);
});

test('seed 7 scripted votes', async ({ request }) => {
  for (const [party, n] of Object.entries(VOTERS)) {
    for (let k = 0; k < n; k++) {
      const r = await apiVote(request, 'stats', { partyId: party, picks: picksAt(OFFSET[party]) });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  }
});

test('overall results: total, counts, one-decimal pct, ordering, no ties', async ({ request }) => {
  const { status, body } = await apiGet(request, 'stats', '/api/results');
  expect(status).toBe(200);
  expect(body.total).toBe(7);
  expect(body.banned).toBe(false);
  expect(body.ties).toEqual([]);
  ROLE_IDS.forEach((roleId, i) => {
    expect(body.byRole[roleId], roleId).toEqual([
      { candidateId: top('likud', i), pct: 57.1, count: 4 },
      { candidateId: top('yashar', i), pct: 28.6, count: 2 },
      { candidateId: top('dems', i), pct: 14.3, count: 1 },
    ]);
  });
});

for (const party of Object.keys(VOTERS)) {
  test(`party=${party} counts only ${party} voters`, async ({ request }) => {
    const { status, body } = await apiGet(request, 'stats', `/api/results?party=${party}`);
    expect(status).toBe(200);
    expect(body.total).toBe(VOTERS[party]);
    expect(body.ties).toEqual([]);
    ROLE_IDS.forEach((roleId, i) => {
      expect(body.byRole[roleId], roleId).toEqual([{ candidateId: top(party, i), pct: 100, count: VOTERS[party] }]);
    });
  });
}

test('results are cached: a new vote is invisible at once, visible within 30s', async ({ request }) => {
  const party = 'utj';
  const before = (await apiGet(request, 'stats', `/api/results?party=${party}`)).body;
  const t0 = Date.now();
  expect(before.total).toBe(0);
  expect((await apiVote(request, 'stats', { partyId: party, picks: picksAt(20) })).status).toBe(201);
  expect((await apiGet(request, 'stats', `/api/results?party=${party}`)).body.total).toBe(0);
  await expect.poll(async () => (await apiGet(request, 'stats', `/api/results?party=${party}`)).body.total,
    { timeout: CACHE_MS + 10_000, intervals: [500] }).toBe(1);
  expect(Date.now() - t0).toBeLessThanOrEqual(CACHE_MS + 2_000);
});

test('equal split sets ties: [roleId] for exactly the tied role', async ({ request }) => {
  const party = 'shas';
  const a = picksAt(30);
  const b = { ...a, pm: ids[50] };
  expect(Object.values(a)).not.toContain(ids[50]);
  expect((await apiVote(request, 'stats', { partyId: party, picks: a })).status).toBe(201);
  expect((await apiVote(request, 'stats', { partyId: party, picks: b })).status).toBe(201);
  const [first, second] = [a.pm, b.pm].sort();
  await fresh(request, `/api/results?party=${party}`, {
    total: 2,
    banned: false,
    ties: ['pm'],
    byRole: Object.fromEntries(ROLE_IDS.map((r) => [r, r === 'pm'
      ? [{ candidateId: first, pct: 50, count: 1 }, { candidateId: second, pct: 50, count: 1 }]
      : [{ candidateId: a[r], pct: 100, count: 2 }]])),
  });
});

test('top 3 only, ties among 3rd/4th broken by candidateId, top two unequal → not in ties', async ({ request }) => {
  const used = new Set([0, 6, 12, 20, 30, 50].map((o) => ids[o]));
  const extra = ids.find((id) => !used.has(id));
  const picks = picksAt(OFFSET.dems);
  const swap = Object.entries(picks).find(([, c]) => c === extra)?.[0];
  if (swap) picks[swap] = picks.pm;
  picks.pm = extra;
  expect(new Set(Object.values(picks)).size).toBe(13);
  expect((await apiVote(request, 'stats', { partyId: 'dems', picks })).status).toBe(201);
  await expect.poll(async () => (await apiGet(request, 'stats', '/api/results')).body.total,
    { timeout: CACHE_MS + 10_000, intervals: [1000] }).toBe(11);
  const { body } = await apiGet(request, 'stats', '/api/results');
  // pm counts now: likud 4, yashar 2, then four candidates with 1 each (dems, utj, 2×shas, extra).
  expect(body.byRole.pm).toHaveLength(3);
  expect(body.byRole.pm.slice(0, 2)).toEqual([
    { candidateId: top('likud', 0), pct: 36.4, count: 4 },
    { candidateId: top('yashar', 0), pct: 18.2, count: 2 },
  ]);
  const ones = [ids[12], ids[20], ids[30], ids[50], extra].sort();
  expect(body.byRole.pm[2]).toEqual({ candidateId: ones[0], pct: 9.1, count: 1 });
  expect(body.ties).not.toContain('pm');
});
