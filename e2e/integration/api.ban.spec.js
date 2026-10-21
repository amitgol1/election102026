import { test, expect } from '@playwright/test';
import { apiVote, apiGet, picksAt, ROLE_IDS } from './helpers.js';

test.beforeAll(async ({ request }) => {
  for (const [partyId, o] of [['likud', 0], ['yashar', 6], ['likud', 0]]) {
    expect((await apiVote(request, 'ban', { partyId, picks: picksAt(o) })).status).toBe(201);
  }
});

test('ban: overall results have pct only, no total, no counts', async ({ request }) => {
  // Results are cached up to 30s; wait until the seeded votes show.
  await expect.poll(async () => (await apiGet(request, 'ban', '/api/results')).body.byRole.pm.length, { timeout: 40_000, intervals: [1000] }).toBeGreaterThan(0);
  const { status, body } = await apiGet(request, 'ban', '/api/results');
  expect(status).toBe(200);
  expect(body.banned).toBe(true);
  expect(Object.keys(body).sort()).toEqual(['banned', 'byRole', 'ties']);
  expect(Array.isArray(body.ties)).toBe(true);
  expect(Object.keys(body.byRole)).toEqual(ROLE_IDS);
  for (const entries of Object.values(body.byRole)) {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(Object.keys(e).sort()).toEqual(['candidateId', 'pct']);
  }
  expect(JSON.stringify(body)).not.toMatch(/count|total|party/i);
});

for (const party of ['likud', 'yashar', 'dems']) {
  test(`ban: party=${party} returns only { banned: true }`, async ({ request }) => {
    const { status, body } = await apiGet(request, 'ban', `/api/results?party=${party}`);
    expect(status).toBe(200);
    expect(body).toEqual({ banned: true });
  });
}
