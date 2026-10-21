import { test, expect } from '@playwright/test';
import { url, freshIp, useRealApi, uiVote, picksAt, data } from './helpers.js';

const CAPTCHA_MSG = 'אימות האבטחה נכשל. נסו לשלוח שוב.';

test('server with always-fail secret: real widget token is rejected, Hebrew message, stays on form', async ({ page }) => {
  await useRealApi(page, freshIp());
  await page.goto(url('captcha'));
  const voteRes = page.waitForResponse((r) => r.url().endsWith('/api/vote'));
  await uiVote(page, data.parties[1].name, picksAt(3));
  const res = await voteRes;
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: 'captcha' });
  await expect(page.locator('#toast')).toHaveText(CAPTCHA_MSG);
  await expect(page.locator('#screen-cabinet')).toBeVisible();
});
