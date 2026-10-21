import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { mockApi, pick, roles, realData, realSuggestions, i18n, noHorizontalOverflow } from './mock.js';

const HEB = /[֐-׿]/;
const data = realData();
const suggestions = realSuggestions();
const RU = i18n('ru');
const FR = i18n('fr');
const picks = Object.fromEntries(roles.map((r, i) => [r.id, data.candidates[i].id]));
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const start = (page, opts = {}) => mockApi(page, { data, suggestions, ...opts });

async function hebrewLeaks(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const skip = (n) => n.closest('.lang-switch, .party-letters, [hidden], .visually-hidden');
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!skip(el) && el.getClientRects().length && re.test(n.data)) out.push(n.data.trim());
    }
    for (const el of document.querySelectorAll('[aria-label], [placeholder], [title]')) {
      if (skip(el)) continue;
      for (const a of ['aria-label', 'placeholder', 'title']) if (re.test(el.getAttribute(a) || '')) out.push(`${a}=${el.getAttribute(a)}`);
    }
    for (const el of document.querySelectorAll('.visually-hidden')) if (re.test(el.textContent)) out.push(`sr=${el.textContent}`);
    return out;
  }, HEB.source);
}

test('switcher sets lang/dir, persists, and ?lang overrides', async ({ page }) => {
  await start(page);
  await page.goto('/');
  await page.getByRole('heading', { name: 'למי אתם מצביעים?' }).waitFor();
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.lang-btn[data-lang="he"]')).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('.lang-btn[data-lang="ru"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.lang-btn[data-lang="he"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('heading', { name: RU.ui.partyTitle })).toBeVisible();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('heading', { name: RU.ui.partyTitle })).toBeVisible();

  await page.goto('/?lang=fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('heading', { name: FR.ui.partyTitle })).toBeVisible();
  await page.getByRole('button', { name: 'עברית' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(new URL(page.url()).searchParams.get('lang')).toBe('he');

  for (const b of await page.locator('.lang-btn').all()) {
    const box = await b.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
});

test('switching language keeps screen, party and picks', async ({ page }) => {
  await start(page);
  await page.goto('/');
  await page.locator(`.party-card[data-party="${data.parties[1].id}"]`).click();
  await pick(page, 'pm', data.candidates[0].name.split(' ')[0], data.candidates[0].id);
  await pick(page, 'defense', data.candidates[1].name.split(' ')[0], data.candidates[1].id);
  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.getByRole('heading', { name: RU.ui.cabinetTitle })).toBeVisible();
  await expect(page.locator('#progress-text')).toHaveText(`2/${roles.length}`);
  await expect(page.locator('#role-pm .picked')).toContainText(RU.candidates[data.candidates[0].id]);
  await expect(page.locator('#role-pm .picked')).toContainText(RU.parties[data.candidates[0].partyId]);
  await expect(page.locator('#role-pm label')).toContainText(RU.roles.pm.name);
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(page.locator('#role-defense .picked')).toContainText(FR.candidates[data.candidates[1].id]);
  await page.locator('#back-party').click();
  await expect(page.locator(`.party-card[data-party="${data.parties[1].id}"]`)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator(`.party-card[data-party="${data.parties[1].id}"] .party-name`)).toHaveText(FR.parties[data.parties[1].id]);
});

for (const [lang, L] of [['ru', RU], ['fr', FR]]) {
  test(`${lang}: no Hebrew on party, cabinet and results screens`, async ({ page }) => {
    let voted = false;
    await start(page, { status: () => (voted ? { voted: true, partyId: data.parties[0].id, picks } : { voted: false }), vote: () => { voted = true; return 201; } });
    await page.goto(`/?lang=${lang}`);
    await page.getByRole('heading', { name: L.ui.partyTitle }).waitFor();
    expect(await hebrewLeaks(page)).toEqual([]);
    await page.locator(`.party-card[data-party="${data.parties[0].id}"]`).click();
    await page.getByRole('heading', { name: L.ui.cabinetTitle }).waitFor();
    await page.locator('#role-pm .quick-chip').first().waitFor();
    await page.locator('#role-defense .quick-chip').first().click();
    await page.locator('#in-foreign').fill(strip(L.candidates[data.candidates[2].id]).slice(0, 2));
    await page.locator('#lb-foreign [role=option]').first().waitFor();
    expect(await hebrewLeaks(page)).toEqual([]);
    await page.goto(`/?lang=${lang}`);
    voted = true;
    await page.reload();
    await page.getByRole('heading', { name: L.ui.majority }).waitFor();
    await expect(page.locator('#disclaimer')).toHaveText(L.ui.disclaimer);
    await expect(page.locator('#majority-list .pill.pct').first()).toBeVisible();
    expect(await hebrewLeaks(page)).toEqual([]);
  });
}

test('ru/fr search matches translated and Hebrew names, ignoring case and diacritics', async ({ page }) => {
  await start(page);
  await page.goto('/?lang=ru');
  await page.locator(`.party-card[data-party="${data.parties[0].id}"]`).click();
  const input = page.locator('#in-pm');
  const target = data.candidates[0];
  const hit = page.locator(`#lb-pm [data-cand="${target.id}"]`);
  const ruLast = RU.candidates[target.id].split(' ').at(-1);
  await input.fill(ruLast.slice(0, 3).toUpperCase());
  await expect(hit).toBeVisible();
  await input.fill(target.name.split(' ')[0].slice(0, 2));
  await expect(hit).toBeVisible();

  await page.getByRole('button', { name: 'Français' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  const accented = data.candidates.find((c) => /[éèêëïîôûüç]/i.test(FR.candidates[c.id]));
  const word = FR.candidates[accented.id].split(' ').find((w) => /[éèêëïîôûüç]/i.test(w));
  const fr = page.locator('#in-pm');
  await fr.fill(strip(word).slice(0, 4));
  await expect(page.locator(`#lb-pm [data-cand="${accented.id}"]`)).toBeVisible();
  await expect(page.locator(`#lb-pm [data-cand="${accented.id}"] .cand-name`)).toHaveText(FR.candidates[accented.id]);
  await fr.fill(word.slice(0, 4).toUpperCase());
  await expect(page.locator(`#lb-pm [data-cand="${accented.id}"]`)).toBeVisible();
  await fr.fill(accented.name.split(' ')[0].slice(0, 2));
  await expect(page.locator(`#lb-pm [data-cand="${accented.id}"]`)).toBeVisible();
  await fr.fill('zzzq');
  await expect(page.locator('#lb-pm [role=option]')).toHaveCount(0);
  await expect(page.locator('#lb-pm .empty')).toHaveText(FR.ui.noMatches);
});

test('LTR: tab arrow keys follow reading direction', async ({ page }) => {
  await start(page, { status: { voted: true, partyId: data.parties[0].id, picks } });
  await page.goto('/?lang=fr');
  await page.getByRole('tab', { name: FR.ui.all }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: FR.parties[data.parties[0].id] })).toHaveAttribute('aria-selected', 'true');
});

for (const [lang, L] of [['ru', RU], ['fr', FR], ['he', null]]) {
  test(`share text in ${lang}`, async ({ page }) => {
    await page.addInitScript(() => {
      window.__shares = [];
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(navigator, 'share', { value: async (d) => { window.__shares.push(d.text); }, configurable: true });
    });
    await start(page, { status: { voted: true, partyId: data.parties[0].id, picks } });
    await page.goto(`/?lang=${lang}`);
    await expect(page.locator('#share-download')).toHaveAttribute('href', /^blob:/);
    await page.locator('#share-btn').click();
    await expect.poll(() => page.evaluate(() => window.__shares.length)).toBe(1);
    const origin = new URL(page.url()).origin;
    const prefix = L ? L.ui.shareText : 'זו נבחרת החלומות שלי לממשלה הבאה. ושלך? בואו לבחור: ';
    expect(await page.evaluate(() => window.__shares[0])).toBe(`${prefix}${origin}/`);
  });
}

test('fr at 360px: no horizontal overflow on any screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  let voted = false;
  await start(page, { status: () => (voted ? { voted: true, partyId: data.parties[0].id, picks } : { voted: false }) });
  await page.goto('/?lang=fr');
  await page.getByRole('heading', { name: FR.ui.partyTitle }).waitFor();
  expect(await noHorizontalOverflow(page)).toBe(true);
  await page.locator(`.party-card[data-party="${data.parties[0].id}"]`).click();
  await page.locator('#role-pm .quick-chip').first().waitFor();
  expect(await noHorizontalOverflow(page)).toBe(true);
  const reason = await page.locator('.quick-reason').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight))));
  expect(reason).toBeLessThanOrEqual(2.05);
  voted = true;
  await page.reload();
  await page.getByRole('heading', { name: FR.ui.majority }).waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('save share image in Russian', async ({ page }, info) => {
  test.skip(info.project.name !== 'iPhone 15', 'one image is enough');
  await start(page, { fonts: true, status: { voted: true, partyId: data.parties[0].id, picks } });
  await page.goto('/?lang=ru');
  await expect(page.locator('#share-download')).toHaveAttribute('href', /^blob:/);
  const b64 = await page.evaluate(async () => {
    const buf = await (await fetch(document.querySelector('#share-download').href)).arrayBuffer();
    let s = '';
    new Uint8Array(buf).forEach((x) => { s += String.fromCharCode(x); });
    return btoa(s);
  });
  writeFileSync(new URL('./screenshots/share-ru.png', import.meta.url), Buffer.from(b64, 'base64'));
});
