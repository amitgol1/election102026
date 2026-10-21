import { test, expect } from '@playwright/test';
import { url, freshIp, useRealApi, uiVote, expectMine, picksAt, apiVote, data, DISCLAIMER, BAN_NOTE } from './helpers.js';

async function expectBanResults(page) {
  await expect(page.getByText(DISCLAIMER)).toBeVisible();
  await expect(page.locator('#ban-note')).toBeVisible();
  await expect(page.locator('#ban-note')).toHaveText(BAN_NOTE);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab')).toHaveText('כולם');
  for (const p of data.parties) await expect(page.getByRole('tab', { name: p.name })).toHaveCount(0);
  await expect(page.locator('#total')).toHaveText('');
  const rows = page.locator('#majority-list > li');
  await expect(rows).toHaveCount(13);
  // Tied roles show two percentages.
  await expect.poll(() => page.locator('#majority-list .pct').count()).toBeGreaterThanOrEqual(13);
  await expect(page.locator('#majority-list')).not.toContainText('הצבעות');
  await expect(page.locator('#majority-title')).toBeVisible();
}

test('ban window: returning voter sees overall cabinet only, no party tabs, no counts', async ({ page, request }) => {
  const v = await apiVote(request, 'ban', { partyId: 'yashar', picks: picksAt(5) });
  expect(v.status).toBe(201);
  await useRealApi(page, freshIp());
  await page.addInitScript((id) => localStorage.setItem('voterId', id), v.voterId);
  await page.goto(url('ban'));
  await expectMine(page, picksAt(5));
  await expectBanResults(page);
});

test('ban window: fresh UI vote lands on banned results', async ({ page }) => {
  await useRealApi(page, freshIp());
  await page.goto(url('ban'));
  await uiVote(page, data.parties[0].name, picksAt(1));
  await expectMine(page, picksAt(1));
  await expectBanResults(page);
});
