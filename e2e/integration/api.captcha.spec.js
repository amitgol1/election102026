import { test, expect } from '@playwright/test';
import { apiVote, apiGet } from './helpers.js';

// "captcha" server runs with Cloudflare's always-fail Turnstile secret.
test('always-fail secret: valid vote → 403 captcha, not stored', async ({ request }) => {
  const v = await apiVote(request, 'captcha');
  expect(v).toMatchObject({ status: 403, body: { error: 'captcha' } });
  expect((await apiGet(request, 'captcha', `/api/status?voterId=${v.voterId}`)).body).toEqual({ voted: false });
});
