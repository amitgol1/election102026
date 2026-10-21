import { test } from '@playwright/test';
import { mockApi, pickParty, fillAll, realData, realSuggestions } from './mock.js';

test('capture screens', async ({ page }, info) => {
  test.skip(info.project.name !== 'iPhone 15', 'screenshots on iPhone size only');
  const data = realData();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { data, fonts: true, ties: ['finance'], empty: ['culture'] });
  const dir = new URL('./screenshots/', import.meta.url).pathname;
  await page.goto('/');
  await page.getByRole('heading', { name: 'למי אתם מצביעים?' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${dir}party.png` });
  await pickParty(page, data.parties[0].id);
  await fillAll(page, data);
  await page.locator('#role-national_security .clear-btn').click();
  await page.locator('#role-culture .clear-btn').click();
  await page.locator('#in-culture').press('Escape');
  await page.locator('#in-culture').blur();
  await page.locator('#role-culture').evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}cabinet.png` });
  await page.locator('#role-culture .quick-chip').first().click();
  await page.locator('#role-national_security .quick-chip').first().click();
  await page.getByRole('button', { name: 'שליחת הנבחרת שלי' }).click();
  await page.getByRole('heading', { name: 'נבחרת הרוב' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}results.png`, fullPage: true });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}results-360.png`, fullPage: true });
});

for (const lang of ['ru', 'fr']) {
  test(`capture screens in ${lang}`, async ({ page }, info) => {
    test.skip(info.project.name !== 'iPhone 15', 'screenshots on iPhone size only');
    const data = realData();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockApi(page, { data, suggestions: realSuggestions(), fonts: true, ties: ['finance'], empty: ['culture'] });
    const dir = new URL('./screenshots/', import.meta.url).pathname;
    await page.goto(`/?lang=${lang}`);
    await page.locator('.party-card').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${dir}party-${lang}.png` });
    await page.locator(`.party-card[data-party="${data.parties[0].id}"]`).click();
    await page.locator('#role-pm .quick-chip').first().waitFor();
    await page.locator('#role-pm .quick-chip').first().click();
    await page.locator('#in-defense').press('Escape');
    await page.locator('#in-defense').blur();
    await page.locator('#role-pm').evaluate((n) => n.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -90));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}cabinet-${lang}.png` });
    await page.locator('#role-pm .clear-btn').click();
    await fillAll(page, data);
    await page.locator('#submit').click();
    await page.locator('#majority-list > li').first().waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}results-${lang}.png`, fullPage: true });
  });
}
