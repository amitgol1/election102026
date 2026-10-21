import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { PORTS, DUMMY_TOKEN } from './env.js';

export const data = JSON.parse(readFileSync(new URL('../../data/candidates.json', import.meta.url), 'utf8'));
export const ROLE_IDS = ['pm', 'defense', 'foreign', 'finance', 'justice', 'transport', 'education', 'sports', 'economy', 'hasbara', 'religion', 'culture', 'national_security'];
export const ROLE_NAMES = ['ראש הממשלה', 'שר הביטחון', 'שר החוץ', 'שר האוצר', 'שר המשפטים', 'שר התחבורה', 'שר החינוך', 'שר הספורט', 'שר הכלכלה', 'שר ההסברה', 'שר הדתות', 'שר התרבות', 'השר לביטחון לאומי'];
export const DISCLAIMER = 'זהו אינו סקר מדעי. התוצאות מבוססות על הצבעות גולשים באתר, אינן מבוססות על שיטה סטטיסטית ואין להסיק מהן על דפוסי הצבעה.';
export const BAN_NOTE = 'פילוח לפי מפלגות יחזור עם סגירת הקלפיות (27.10, 22:00)';
export const RATE_MSG = 'נשלחו יותר מדי הצבעות מהרשת שלכם היום. נסו שוב מחר.';

export const url = (server, path = '/') => `http://localhost:${PORTS[server]}${path}`;
export const uuid = () => crypto.randomUUID();
export const candName = (id) => data.candidates.find((c) => c.id === id).name;

let ipSeq = 0;
export const freshIp = () => `10.${process.pid % 250}.${Math.floor(Math.random() * 250)}.${++ipSeq % 250}`;

// Distinct candidates per voter: role i gets candidate (offset + i) mod N.
export function picksAt(offset) {
  const ids = data.candidates.map((c) => c.id);
  return Object.fromEntries(ROLE_IDS.map((r, i) => [r, ids[(offset + i) % ids.length]]));
}

export const voteHeaders = (server, ip = freshIp()) => ({
  'content-type': 'application/json',
  origin: url(server, '').replace(/\/$/, ''),
  ...(ip ? { 'CF-Connecting-IP': ip } : {}),
});

export async function apiVote(request, server, { voterId = uuid(), partyId = 'likud', picks = picksAt(0), ip = freshIp(), turnstileToken = DUMMY_TOKEN } = {}) {
  const res = await request.post(url(server, '/api/vote'), {
    data: JSON.stringify({ voterId, partyId, picks, turnstileToken }),
    headers: voteHeaders(server, ip),
  });
  return { status: res.status(), body: await res.json().catch(() => null), voterId };
}

export async function apiGet(request, server, path) {
  const res = await request.get(url(server, path));
  return { status: res.status(), body: await res.json().catch(() => null) };
}

// Real backend; only adds the client-IP header the Cloudflare edge would set, and blocks external fonts.
export async function useRealApi(page, ip) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.route('**/api/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function pickParty(page, name) {
  await page.getByRole('radio', { name: new RegExp(`^${esc(name)}`) }).click();
  await page.getByRole('heading', { name: 'הרכיבו את הממשלה שלכם' }).waitFor();
}

export async function fillPicks(page, picks) {
  for (const [i, roleId] of ROLE_IDS.entries()) {
    const name = candName(picks[roleId]);
    const input = page.getByRole('combobox', { name: ROLE_NAMES[i], exact: true });
    await input.click();
    await input.fill(name);
    const listbox = page.getByRole('listbox', { name: new RegExp(`${esc(ROLE_NAMES[i])}$`) });
    await listbox.getByRole('option').filter({ has: page.locator('.cand-name', { hasText: new RegExp(`^${esc(name)}$`) }) }).first().click();
  }
  await expect(page.locator('#progress-text')).toHaveText('13/13');
}

export async function uiVote(page, partyName, picks) {
  await pickParty(page, partyName);
  await fillPicks(page, picks);
  await page.getByRole('button', { name: 'שליחת הנבחרת שלי' }).click();
}

export async function expectMine(page, picks) {
  await expect(page.locator('#screen-results')).toBeVisible();
  await expect(page.locator('#mine-list > li')).toHaveCount(13);
  for (const [i, roleId] of ROLE_IDS.entries()) {
    const token = page.locator(`#mine-list > li[data-role="${roleId}"]`);
    await expect(token).toContainText(ROLE_NAMES[i]);
    await expect(token).toContainText(candName(picks[roleId]));
  }
}
