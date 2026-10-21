import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { mockApi, fixture, roles, realData } from './mock.js';

const TEXT_PREFIX = 'זו נבחרת החלומות שלי לממשלה הבאה. ושלך? בואו לבחור: ';
const picksFrom = (data) => Object.fromEntries(roles.map((r, i) => [r.id, data.candidates[i].id]));

async function stubShare(page, mode) {
  await page.addInitScript((m) => {
    window.__shares = [];
    const record = (d) => window.__shares.push({ text: d.text, url: d.url, files: (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) });
    const def = (k, v) => Object.defineProperty(navigator, k, { value: v, configurable: true });
    if (m === 'none') { def('share', undefined); def('canShare', undefined); return; }
    def('canShare', () => m !== 'text');
    def('share', async (d) => {
      record(d);
      if (m === 'abort') throw new DOMException('cancelled', 'AbortError');
      if (m === 'fail') throw new DOMException('denied', 'NotAllowedError');
    });
  }, mode);
}

async function openResults(page, mode, data = fixture) {
  await stubShare(page, mode);
  await mockApi(page, { data, status: { voted: true, partyId: data.parties[0].id, picks: picksFrom(data) } });
  await page.goto('/');
  await expect(page.locator('#share-download')).toHaveAttribute('href', /^blob:/);
}

const expectedText = (page) => `${TEXT_PREFIX}${new URL(page.url()).origin}/`;

async function imageInfo(page) {
  return page.evaluate(async () => {
    const blob = await (await fetch(document.querySelector('#share-download').href)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) colors.add((data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | (data[i + 2] >> 3));
    return { type: blob.type, size: blob.size, width: bmp.width, height: bmp.height, colors: colors.size };
  });
}

test('share image is a 1080x1350 PNG with real content', async ({ page }) => {
  await openResults(page, 'files');
  const info = await imageInfo(page);
  expect(info).toMatchObject({ type: 'image/png', width: 1080, height: 1350 });
  expect(info.size).toBeGreaterThan(30000);
  expect(info.colors).toBeGreaterThan(50);
});

test('file share: navigator.share gets the PNG file and the exact text', async ({ page }) => {
  await openResults(page, 'files');
  await page.getByRole('button', { name: 'שתפו את הנבחרת שלי' }).click();
  await expect.poll(() => page.evaluate(() => window.__shares.length)).toBe(1);
  const [s] = await page.evaluate(() => window.__shares);
  expect(s.text).toBe(expectedText(page));
  expect(s.url).toBeUndefined();
  expect(s.files).toEqual([{ name: 'nivheret-hachalomot.png', type: 'image/png', size: expect.any(Number) }]);
  expect(s.files[0].size).toBeGreaterThan(30000);
  await expect(page.locator('#share-download')).toBeHidden();
  await expect(page.locator('#toast')).toBeHidden();
});

test('no file support: shares text (URL inside) and offers the download', async ({ page }) => {
  await openResults(page, 'text');
  await page.getByRole('button', { name: 'שתפו את הנבחרת שלי' }).click();
  await expect.poll(() => page.evaluate(() => window.__shares.length)).toBe(1);
  const [s] = await page.evaluate(() => window.__shares);
  expect(s).toEqual({ text: expectedText(page), url: undefined, files: [] });
  await expect(page.getByRole('link', { name: 'שמירת התמונה' })).toBeVisible();
});

test('no Web Share: opens wa.me with the text and offers a .png download', async ({ page, context }) => {
  await context.route('https://wa.me/**', (r) => r.fulfill({ contentType: 'text/html', body: 'ok' }));
  await openResults(page, 'none');
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'שתפו את הנבחרת שלי' }).click();
  const url = new URL((await popup).url());
  expect(url.origin).toBe('https://wa.me');
  expect(url.searchParams.get('text')).toBe(expectedText(page));
  const link = page.getByRole('link', { name: 'שמירת התמונה' });
  await expect(link).toBeVisible();
  const download = page.waitForEvent('download');
  await link.click();
  expect((await download).suggestedFilename()).toBe('nivheret-hachalomot.png');
});

test('user cancelling the share sheet is not an error', async ({ page }) => {
  await openResults(page, 'abort');
  await page.getByRole('button', { name: 'שתפו את הנבחרת שלי' }).click();
  await expect.poll(() => page.evaluate(() => window.__shares.length)).toBe(1);
  await page.waitForTimeout(300);
  await expect(page.locator('#toast')).toBeHidden();
  await expect(page.locator('#share-download')).toBeHidden();
});

test('other share errors show a Hebrew message and the download', async ({ page }) => {
  await openResults(page, 'fail');
  await page.getByRole('button', { name: 'שתפו את הנבחרת שלי' }).click();
  await expect(page.locator('#toast')).toHaveText('השיתוף לא הצליח. אפשר לשמור את התמונה ולשתף ידנית.');
  await expect(page.getByRole('link', { name: 'שמירת התמונה' })).toBeVisible();
});

test('share button sits under my cabinet, above the ad slot, and only when picks are known', async ({ page }) => {
  await openResults(page, 'files');
  const order = await page.evaluate(() => [...document.querySelectorAll('#mine-list, #share-btn, #ad-slot')].map((n) => n.id));
  expect(order).toEqual(['mine-list', 'share-btn', 'ad-slot']);
  await expect(page.locator('#share-btn')).toBeVisible();
});

test('no share button without my picks', async ({ page }) => {
  await mockApi(page, { status: { voted: true } });
  await page.goto('/');
  await page.getByRole('heading', { name: 'נבחרת הרוב' }).waitFor();
  await expect(page.locator('#share-btn')).toBeHidden();
});

test('page has link-preview meta tags', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  const meta = (sel) => page.locator(sel).getAttribute('content');
  expect(await meta('meta[property="og:title"]')).toBe('נבחרת החלומות 2026');
  expect(await meta('meta[property="og:description"]')).toBe('בחרו את 13 השרים של נבחרת החלומות שלכם והשוו לנבחרת הרוב');
  expect(await meta('meta[property="og:type"]')).toBe('website');
  expect(await meta('meta[name="twitter:card"]')).toBe('summary');
});

test('save share image with real data', async ({ page }, info) => {
  test.skip(info.project.name !== 'iPhone 15', 'one image is enough');
  await stubShare(page, 'files');
  const data = realData();
  await mockApi(page, { data, fonts: true, status: { voted: true, partyId: data.parties[0].id, picks: picksFrom(data) } });
  await page.goto('/');
  await expect(page.locator('#share-download')).toHaveAttribute('href', /^blob:/);
  const b64 = await page.evaluate(async () => {
    const buf = await (await fetch(document.querySelector('#share-download').href)).arrayBuffer();
    let s = '';
    new Uint8Array(buf).forEach((x) => { s += String.fromCharCode(x); });
    return btoa(s);
  });
  writeFileSync(new URL('./screenshots/share.png', import.meta.url), Buffer.from(b64, 'base64'));
});
