import { test, expect } from '@playwright/test';
import { url, freshIp, useRealApi, uiVote, expectMine, picksAt, apiVote, apiGet, data, ROLE_IDS, ROLE_NAMES, candName, DISCLAIMER, RATE_MSG } from './helpers.js';
import { IP_DAILY_LIMIT } from './env.js';

const partyName = (id) => data.parties.find((p) => p.id === id).name;
const TS = /challenges\.cloudflare\.com/;

test('full vote with the real Turnstile widget; reload lands on results; party tab renders that party\'s results', async ({ page, request }) => {
  await useRealApi(page, freshIp());
  const tsFrames = [];
  page.on('framenavigated', (f) => { if (TS.test(f.url())) tsFrames.push(f.url()); });
  const tsScript = page.waitForResponse((r) => TS.test(r.url()) && r.url().includes('/turnstile/v0/api.js'));
  await page.goto(url('normal'));
  const picks = picksAt(2);
  const voteReq = page.waitForRequest((r) => r.url().endsWith('/api/vote') && r.method() === 'POST');
  const voteRes = page.waitForResponse((r) => r.url().endsWith('/api/vote'));
  await uiVote(page, partyName('yashar'), picks);
  expect((await tsScript).status()).toBeLessThan(400);
  expect(await page.evaluate(() => typeof window.turnstile?.render)).toBe('function');
  expect(tsFrames.length, 'Turnstile iframe from challenges.cloudflare.com').toBeGreaterThan(0);
  const sent = (await voteReq).postDataJSON();
  const token = sent.turnstileToken;
  test.info().annotations.push({ type: 'turnstileToken', description: String(token) });
  expect(typeof token).toBe('string');
  expect(token.length).toBeGreaterThan(0);
  expect((await voteRes).status()).toBe(201);
  await expectMine(page, picks);
  await expect(page.getByText(DISCLAIMER)).toBeVisible();

  const voterId = await page.evaluate(() => localStorage.getItem('voterId'));
  expect(sent.voterId).toBe(voterId);
  expect((await apiGet(request, 'normal', `/api/status?voterId=${voterId}`)).body).toEqual({ voted: true, partyId: 'yashar', picks });

  await page.reload();
  await expectMine(page, picks);
  await expect(page.locator('#screen-party')).toBeHidden();

  await expect(page.getByRole('tab')).toHaveCount(1 + data.parties.length);
  const partyRes = page.waitForResponse((r) => r.url().includes('/api/results?party=yashar'));
  await page.getByRole('tab', { name: partyName('yashar') }).click();
  const api = await (await partyRes).json();
  const rows = page.locator('#majority-list > li');
  await expect(rows).toHaveCount(13);
  for (const [i, roleId] of ROLE_IDS.entries()) {
    const token = page.locator(`#majority-list > li[data-role="${roleId}"]`);
    await expect(token).toContainText(ROLE_NAMES[i]);
    const t = api.byRole[roleId][0];
    if (t) await expect(token).toContainText(candName(t.candidateId));
  }
  await expect(page.locator('#total')).toContainText(String(api.total));
});

test('409 on submit (voterId already used elsewhere) shows the server-side picks', async ({ page, request }) => {
  await useRealApi(page, freshIp());
  await page.goto(url('normal'));
  await expect(page.locator('#screen-party')).toBeVisible();
  const voterId = await page.evaluate(() => localStorage.getItem('voterId'));
  const serverPicks = picksAt(7);
  expect((await apiVote(request, 'normal', { voterId, partyId: 'dems', picks: serverPicks })).status).toBe(201);
  await uiVote(page, partyName('likud'), picksAt(0));
  await expectMine(page, serverPicks);
});

test(`clearing localStorage allows re-voting from same IP until IP_DAILY_LIMIT=${IP_DAILY_LIMIT}`, async ({ page, request }) => {
  const ip = freshIp();
  await useRealApi(page, ip);
  const ids = [];
  for (let n = 1; n <= IP_DAILY_LIMIT; n++) {
    await page.goto(url('normal'));
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    if (n === 2) {
      // Seed one vote from this IP via API to save UI time; counts toward the same limit.
      expect((await apiVote(request, 'normal', { ip })).status).toBe(201);
      n++;
    }
    await uiVote(page, partyName('likud'), picksAt(n));
    await expectMine(page, picksAt(n));
    ids.push(await page.evaluate(() => localStorage.getItem('voterId')));
  }
  expect(new Set(ids).size).toBe(ids.length);

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await uiVote(page, partyName('likud'), picksAt(9));
  await expect(page.locator('#toast')).toHaveText(RATE_MSG);
  await expect(page.locator('#screen-cabinet')).toBeVisible();
  await expect(page.locator('#screen-results')).toBeHidden();
});

test('tied role shows both leaders and "תיקו" (real API)', async ({ page, request }) => {
  const a = picksAt(40);
  const b = { ...a, pm: data.candidates[60].id };
  expect(Object.values(a)).not.toContain(b.pm);
  const v = await apiVote(request, 'normal', { partyId: 'amcha', picks: a });
  expect(v.status).toBe(201);
  expect((await apiVote(request, 'normal', { partyId: 'amcha', picks: b })).status).toBe(201);
  await useRealApi(page, freshIp());
  await page.addInitScript((id) => localStorage.setItem('voterId', id), v.voterId);
  await page.goto(url('normal'));
  await expectMine(page, a);
  const tab = page.getByRole('tab', { name: partyName('amcha') });
  // Results are cached up to 30s: re-select the tab until the tie shows.
  await expect.poll(async () => {
    await page.getByRole('tab', { name: 'כולם' }).click();
    const res = page.waitForResponse((r) => r.url().includes('/api/results?party=amcha'));
    await tab.click();
    await res;
    await expect(page.locator('#majority-list')).not.toHaveClass(/loading/);
    return page.locator('#majority-list > li[data-role="pm"]').textContent();
  }, { timeout: 45_000, intervals: [2000] }).toContain('תיקו');
  const pmRow = page.locator('#majority-list > li[data-role="pm"]');
  await expect(pmRow).toContainText(candName(a.pm));
  await expect(pmRow).toContainText(candName(b.pm));
});

test('non-UUID voterId in localStorage (XSS-shaped) is replaced, never executed', async ({ page }) => {
  await useRealApi(page, freshIp());
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('voterId', '<img src=x onerror="window.__xss=1">');
      sessionStorage.setItem('seeded', '1');
    }
  });
  await page.goto(url('normal'));
  await expect(page.locator('#screen-party')).toBeVisible();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem('voterId'))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
