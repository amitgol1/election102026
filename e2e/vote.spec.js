import { test, expect } from '@playwright/test';
import { mockApi, pickParty, pick, fillAll, fixture, roles, noHorizontalOverflow, REASONS } from './mock.js';

const DISCLAIMER = 'זהו אינו סקר מדעי';
const SUBMIT = 'שליחת הנבחרת שלי';
const [p0, p1] = fixture.parties;
const C = fixture.candidates;
const wordsOf = (c) => c.name.replace(/וו/g, 'ו').split(/\s+/);
const countPrefix = (q, exclude = []) => C.filter((c) => !exclude.includes(c.id) && wordsOf(c).some((w) => w.startsWith(q))).length;

async function start(page, opts) {
  const calls = await mockApi(page, opts);
  await page.goto('/');
  return calls;
}

test('full vote flow', async ({ page }) => {
  const calls = await start(page);
  await pickParty(page, p1.id);
  await expect(page.getByText('0/13')).toBeVisible();
  await fillAll(page);
  await expect(page.getByText('13/13')).toBeVisible();
  await page.getByRole('button', { name: SUBMIT }).click();

  await expect(page.getByRole('heading', { name: 'הנבחרת שלי' })).toBeVisible();
  await expect(page.getByText(DISCLAIMER)).toBeVisible();
  await expect(page.locator('#majority-list > li')).toHaveCount(13);
  await expect(page.locator('#mine-list > li')).toHaveCount(13);

  expect(calls.votes).toHaveLength(1);
  const [vote] = calls.votes;
  expect(vote.partyId).toBe(p1.id);
  expect(vote.voterId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(Object.keys(vote.picks).sort()).toEqual(roles.map((r) => r.id).sort());
  expect(new Set(Object.values(vote.picks)).size).toBe(13);
  expect(calls.voteHeaders[0]['content-type']).toBe('application/json');
  expect(await page.evaluate(() => localStorage.getItem('voterId'))).toBe(vote.voterId);
  expect(await page.evaluate(() => sessionStorage.getItem('draft'))).toBeNull();

  await page.getByRole('tab', { name: p0.name }).click();
  await expect(page.getByRole('tab', { name: p0.name })).toHaveAttribute('aria-selected', 'true');
  const firstOfP0 = C.find((c) => c.partyId === p0.id);
  await expect(page.locator('#majority-list')).toContainText(firstOfP0.name);
});

test('ad slot sits between my cabinet and majority cabinet', async ({ page }) => {
  await start(page, { status: { voted: true, partyId: p0.id, picks: {} } });
  await page.getByRole('heading', { name: 'נבחרת הרוב' }).waitFor();
  const order = await page.evaluate(() => [...document.querySelectorAll('#mine-block, #ad-slot, #majority-title')].map((n) => n.id));
  expect(order).toEqual(['mine-block', 'ad-slot', 'majority-title']);
  expect(await page.locator('#ad-slot').evaluate((n) => n.getBoundingClientRect().height)).toBeCloseTo(250, 1);
});

test('autocomplete matches prefix of any word, ignoring niqqud and quotes', async ({ page }) => {
  await start(page);
  await pickParty(page);
  const input = page.locator('#in-pm');
  const options = page.locator('#lb-pm [role=option]');
  const target = C.find((c) => wordsOf(c).length > 1);
  const second = wordsOf(target)[1];
  const q = second.slice(0, 2);

  await input.fill(q);
  await expect(options).toHaveCount(countPrefix(q));
  await expect(page.locator(`#lb-pm [data-cand="${target.id}"]`)).toBeVisible();

  await input.fill(`${q[0]}ִ${q.slice(1)}`);
  await expect(options).toHaveCount(countPrefix(q));
  await expect(page.locator(`#lb-pm [data-cand="${target.id}"]`)).toBeVisible();

  await input.fill(`${q[0]}"${q.slice(1)}`);
  await expect(options).toHaveCount(countPrefix(q));

  const mid = second.slice(1, 3);
  await input.fill(mid);
  await expect(options).toHaveCount(countPrefix(mid));
  if (!countPrefix(mid)) await expect(page.getByText('לא נמצאו מועמדים')).toBeVisible();
});

test('keyboard selection and clearing', async ({ page }) => {
  await start(page);
  await pickParty(page);
  const input = page.locator('#in-foreign');
  await input.click();
  await input.fill(wordsOf(C[0])[0]);
  await input.press('ArrowDown');
  await input.press('Enter');
  const role = page.locator('#role-foreign');
  await expect(role.locator('.picked')).toBeVisible();
  await expect(page.getByText('1/13')).toBeVisible();
  await role.getByRole('button', { name: /ניקוי/ }).click();
  await expect(page.getByText('0/13')).toBeVisible();
  await expect(input).toBeVisible();
});

test('picked candidate is excluded from other roles', async ({ page }) => {
  await start(page);
  await pickParty(page);
  const cand = C[0];
  const q = wordsOf(cand)[0];
  await pick(page, 'pm', q, cand.id);
  const other = page.locator('#in-defense');
  await other.click();
  await other.fill(q);
  await expect(page.locator(`#lb-defense [data-cand="${cand.id}"]`)).toHaveCount(0);
  await expect(page.locator('#lb-defense [role=option]')).toHaveCount(countPrefix(q, [cand.id]));
  await page.locator('#role-pm').getByRole('button', { name: /ניקוי/ }).click();
  await other.click();
  await other.fill(q);
  await expect(page.locator(`#lb-defense [data-cand="${cand.id}"]`)).toHaveCount(1);
});

test('submit disabled until all 13 roles are filled', async ({ page }) => {
  await start(page);
  await pickParty(page);
  const submit = page.getByRole('button', { name: SUBMIT });
  for (const [i, r] of roles.entries()) {
    await expect(submit).toBeDisabled();
    await pick(page, r.id, wordsOf(C[i]).at(-1), C[i].id);
  }
  await expect(submit).toBeEnabled();
});

test('returning voter goes straight to results', async ({ page }) => {
  const picks = Object.fromEntries(roles.map((r, i) => [r.id, C[i].id]));
  await start(page, { status: { voted: true, partyId: p0.id, picks } });
  await expect(page.getByRole('heading', { name: 'נבחרת הרוב' })).toBeVisible();
  await expect(page.getByText(DISCLAIMER)).toBeVisible();
  await expect(page.locator('#mine-list > li')).toHaveCount(13);
  await expect(page.locator('#screen-party')).toBeHidden();
  await expect(page.getByRole('tab')).toHaveCount(1 + fixture.parties.length);
});

test('409 on submit goes to results', async ({ page }) => {
  let voted = false;
  await start(page, { vote: () => { voted = true; return 409; }, status: () => ({ voted }) });
  await pickParty(page);
  await fillAll(page);
  await page.getByRole('button', { name: SUBMIT }).click();
  await expect(page.getByRole('heading', { name: 'נבחרת הרוב' })).toBeVisible();
});

test('429 shows a Hebrew message and stays on the form', async ({ page }) => {
  await start(page, { vote: 429 });
  await pickParty(page);
  await fillAll(page);
  await page.getByRole('button', { name: SUBMIT }).click();
  await expect(page.locator('#toast')).toContainText('נסו שוב מחר');
  await expect(page.getByRole('button', { name: SUBMIT })).toBeEnabled();
});

test('403 forbidden shows a generic Hebrew error', async ({ page }) => {
  await start(page, { vote: () => [403, { error: 'forbidden' }] });
  await pickParty(page);
  await fillAll(page);
  await page.getByRole('button', { name: SUBMIT }).click();
  await expect(page.locator('#toast')).toHaveText('אירעה שגיאה. נסו שוב בעוד רגע.');
  await expect(page.locator('#screen-cabinet')).toBeVisible();
});

test('turnstile renders in Hebrew and its token is sent with the vote', async ({ page }) => {
  const calls = await start(page);
  await pickParty(page);
  await expect.poll(() => page.evaluate(() => window.__ts?.renders.length)).toBe(1);
  const [opts] = await page.evaluate(() => window.__ts.renders);
  expect(opts).toMatchObject({ sitekey: 'test-site-key', language: 'he', size: 'flexible', appearance: 'interaction-only' });
  await fillAll(page);
  await page.getByRole('button', { name: SUBMIT }).click();
  await page.getByRole('heading', { name: 'נבחרת הרוב' }).waitFor();
  expect(calls.votes[0].turnstileToken).toBe('token-1');
});

test('403 captcha resets the widget, shows a message, and retry sends a fresh token', async ({ page }) => {
  const calls = await start(page, { vote: () => (calls.votes.length === 1 ? 403 : 201) });
  await pickParty(page);
  await fillAll(page);
  await page.getByRole('button', { name: SUBMIT }).click();
  await expect(page.locator('#toast')).toContainText('אימות האבטחה נכשל');
  expect(await page.evaluate(() => window.__ts.resets)).toBe(1);
  await page.getByRole('button', { name: SUBMIT }).click();
  await page.getByRole('heading', { name: 'נבחרת הרוב' }).waitFor();
  expect(calls.votes.map((v) => v.turnstileToken)).toEqual(['token-1', 'token-2']);
});

test('tied role shows both leaders with "תיקו"', async ({ page }) => {
  await start(page, { status: { voted: true }, ties: ['pm'] });
  const row = page.locator('#majority-list > li[data-role="pm"]');
  await expect(row).toContainText('תיקו');
  await expect(row.locator('.avatar')).toHaveCount(2);
  await expect(row.locator('.player-name')).toHaveText([C[0].name, C[1].name]);
  await expect(row.locator('.pill.tie-pill')).toBeVisible();
  await expect(page.locator('#majority-list > li[data-role="defense"]')).not.toContainText('תיקו');
});

test('back from cabinet returns to party screen; reload keeps party and picks', async ({ page }) => {
  await start(page);
  await pickParty(page, p1.id);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'למי אתם מצביעים?' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'הרכיבו את הממשלה שלכם' })).toBeVisible();
  await pick(page, 'pm', wordsOf(C[0])[0], C[0].id);
  await pick(page, 'defense', wordsOf(C[1])[0], C[1].id);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'הרכיבו את הממשלה שלכם' })).toBeVisible();
  await expect(page.getByText('2/13')).toBeVisible();
  await expect(page.locator('#role-pm .picked')).toContainText(C[0].name);
  await page.getByRole('button', { name: /שינוי מפלגה/ }).click();
  await expect(page.locator(`.party-card[data-party="${p1.id}"]`)).toHaveAttribute('aria-checked', 'true');
});

test('switching tabs re-fetches results and follows ban start/end', async ({ page }) => {
  let banned = false;
  const calls = await start(page, { status: { voted: true }, banned: () => banned });
  await expect(page.getByRole('tab')).toHaveCount(1 + fixture.parties.length);
  banned = true;
  await page.getByRole('tab', { name: p0.name }).click();
  await expect(page.getByText('פילוח לפי מפלגות יחזור')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(1);
  banned = false;
  await page.getByRole('tab', { name: 'כולם' }).click();
  await expect(page.getByRole('tab')).toHaveCount(1 + fixture.parties.length);
  await expect(page.getByText('פילוח לפי מפלגות יחזור')).toBeHidden();
  await page.getByRole('tab', { name: 'כולם' }).click();
  await expect.poll(() => calls.results.filter((p) => p === null).length).toBeGreaterThanOrEqual(4);
});

test('network error on load shows retry', async ({ page }) => {
  await page.route('**/api/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.getByText('אין חיבור לשרת')).toBeVisible();
  await page.unroute('**/api/**');
  await mockApi(page);
  await page.getByRole('button', { name: 'נסו שוב' }).click();
  await expect(page.getByRole('heading', { name: 'למי אתם מצביעים?' })).toBeVisible();
});

test('ban mode hides party tabs and shows the notice', async ({ page }) => {
  await start(page, { status: { voted: true }, banned: true });
  await expect(page.getByText('פילוח לפי מפלגות יחזור עם סגירת הקלפיות (27.10, 22:00)')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'כולם' })).toBeVisible();
  await expect(page.locator('#total')).toHaveText('');
  await expect(page.locator('#majority-list')).toContainText('46.3%');
  await expect(page.getByText(DISCLAIMER)).toBeVisible();
});

test('no horizontal overflow at 360px on every screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await start(page);
  await page.getByRole('heading', { name: 'למי אתם מצביעים?' }).waitFor();
  expect(await noHorizontalOverflow(page)).toBe(true);
  await pickParty(page);
  const input = page.locator('#in-pm');
  await input.click();
  await input.fill(C[0].name[0]);
  expect(await noHorizontalOverflow(page)).toBe(true);
  await fillAll(page);
  expect(await noHorizontalOverflow(page)).toBe(true);
  await page.getByRole('button', { name: SUBMIT }).click();
  await page.getByRole('heading', { name: 'נבחרת הרוב' }).waitFor();
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('inputs are at least 16px and touch targets at least 44px', async ({ page }) => {
  await start(page);
  await pickParty(page);
  const fontSize = await page.locator('.combo-input').first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
  await pick(page, 'pm', wordsOf(C[0])[0], C[0].id);
  for (const loc of [page.locator('.combo-input:visible').first(), page.locator('.clear-btn').first(), page.locator('#back-party'), page.locator('.option').first()]) {
    if (!(await loc.count())) continue;
    await loc.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    const box = await loc.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

const N = roles.length;
const FORMATION = [['pm'], ['defense', 'finance', 'foreign', 'justice'], ['transport', 'education', 'national_security', 'economy'], ['sports', 'hasbara', 'religion', 'culture']];

test('results plenums use the 1-4-4-4 tiers, arced and widening downward', async ({ page }) => {
  const picks = Object.fromEntries(roles.map((r, i) => [r.id, C[i].id]));
  await start(page, { status: { voted: true, partyId: p0.id, picks } });
  for (const list of ['#mine-list', '#majority-list']) {
    const items = page.locator(`${list} > li`);
    await expect(items).toHaveCount(N);
    expect(await items.evaluateAll((els) => els.map((e) => e.dataset.role))).toEqual(FORMATION.flat());
    const box = await items.evaluateAll((els) => Object.fromEntries(els.map((e) => {
      const r = e.getBoundingClientRect();
      return [e.dataset.role, { top: r.top, bottom: r.bottom, left: r.left, right: r.right }];
    })));
    for (let i = 1; i < FORMATION.length; i++) {
      const above = Math.max(...FORMATION[i - 1].map((id) => box[id].bottom));
      expect(Math.min(...FORMATION[i].map((id) => box[id].top))).toBeGreaterThan(above);
    }
    for (const row of FORMATION.slice(1)) {
      const [outer, inner] = [box[row[0]].top, box[row[1]].top];
      expect(inner).toBeGreaterThan(outer);
    }
    const width = (row) => Math.max(...row.map((id) => box[id].right)) - Math.min(...row.map((id) => box[id].left));
    expect(width(FORMATION[1])).toBeLessThan(width(FORMATION[2]));
    expect(width(FORMATION[2])).toBeLessThan(width(FORMATION[3]));
  }
});

test('plenum seats are announced as "role: name, party, pct"', async ({ page }) => {
  const picks = Object.fromEntries(roles.map((r, i) => [r.id, C[i].id]));
  await start(page, { status: { voted: true, partyId: p0.id, picks }, empty: ['culture'] });
  const partyOf = (c) => fixture.parties.find((p) => p.id === c.partyId).name;
  await expect(page.locator('#mine-list')).toHaveAttribute('aria-labelledby', 'mine-title');
  await expect(page.locator('#mine-list > li[data-role="justice"] .visually-hidden'))
    .toHaveText(new RegExp(`^שר המשפטים: ${C[4].name}, ${partyOf(C[4])}`));
  const pm = page.locator('#majority-list > li[data-role="pm"]');
  await expect(pm.locator('.visually-hidden')).toHaveText(`ראש הממשלה: ${C[0].name}, ${partyOf(C[0])}, 46.3%, כמו הבחירה שלך`);
  await expect(pm.locator('.pill.pct')).toHaveText('46.3%');
  await expect(pm.locator('.player-role')).toHaveText('ראש הממשלה');
  await expect(pm.locator('.gov-table')).toHaveText('שולחן הממשלה');
  await expect(pm).toHaveAttribute('title', 'ראש הממשלה');
  await expect(page.locator('#majority-list > li[data-role="national_security"] .player-role')).toHaveText('בט"ל');
  const empty = page.locator('#majority-list > li[data-role="culture"]');
  await expect(empty.locator('.avatar.empty')).toHaveText('—');
  await expect(empty.locator('.visually-hidden')).toHaveText('שר התרבות: אין עדיין הצבעות');
});

test('tapping a token reveals the party', async ({ page }) => {
  const picks = Object.fromEntries(roles.map((r, i) => [r.id, C[i].id]));
  await start(page, { status: { voted: true, partyId: p0.id, picks } });
  const tok = page.locator('#mine-list > li[data-role="defense"]');
  await expect(tok.locator('.player-party')).toBeHidden();
  await tok.click();
  await expect(tok.locator('.player-party')).toBeVisible();
});

test('plenum fits 360px: seats inside the plenum, names at most 2 lines', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const long = { ...fixture, candidates: fixture.candidates.map((c, i) => (i === 1 ? { ...c, name: 'בן־אליעזר־וולפסון שם ארוך מאוד מאוד במיוחד' } : c)) };
  const picks = Object.fromEntries(roles.map((r, i) => [r.id, long.candidates[i].id]));
  await start(page, { data: long, status: { voted: true, partyId: p0.id, picks } });
  await page.locator('#mine-list > li').first().waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  expect(await noHorizontalOverflow(page)).toBe(true);
  for (const list of ['#mine-list', '#majority-list']) {
    const bad = await page.locator(list).evaluate((ol) => {
      const pitch = ol.closest('.plenum').getBoundingClientRect();
      return [...ol.children].filter((li) => {
        const r = li.getBoundingClientRect();
        const name = li.querySelector('.player-name');
        const lh = parseFloat(getComputedStyle(name).lineHeight);
        return r.left < pitch.left || r.right > pitch.right || name.getBoundingClientRect().height > lh * 2 + 1;
      }).map((li) => li.dataset.role);
    });
    expect(bad).toEqual([]);
  }
});

test.describe('quick picks', () => {
  const chips = (page, role) => page.locator(`#role-${role} .quick-chip`);
  const ids = (page, role) => chips(page, role).evaluateAll((els) => els.map((e) => e.dataset.cand));

  test('popular first with label, then curated; max 4; deduped; unknown ids ignored', async ({ page }) => {
    await start(page);
    await pickParty(page);
    await expect(chips(page, 'pm')).toHaveCount(4);
    expect(await ids(page, 'pm')).toEqual([C[0].id, C[1].id, C[3].id, C[5].id]);
    await expect(chips(page, 'pm').nth(0).locator('.quick-reason')).toHaveText('פופולרי · 46%');
    await expect(chips(page, 'pm').nth(1).locator('.quick-reason')).toHaveText('פופולרי · 28%');
    await expect(chips(page, 'pm').nth(2).locator('.quick-reason')).toHaveText(REASONS[0]);
    await expect(chips(page, 'pm').nth(2)).toHaveAttribute('aria-label', `בחירה מהירה: ${C[3].name}, ${REASONS[0]}, לתפקיד ראש הממשלה`);
    await expect(chips(page, 'pm').nth(0)).toHaveAttribute('aria-label', `בחירה מהירה: ${C[0].name}, פופולרי, לתפקיד ראש הממשלה`);
    await expect(page.locator('.quick-chip[data-cand="no-such-candidate"]')).toHaveCount(0);
    for (const r of roles) expect(await chips(page, r.id).count()).toBeLessThanOrEqual(4);
    const h = await chips(page, 'pm').first().evaluate((n) => n.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(44);
  });

  test('popular only when total >= 30', async ({ page }) => {
    await start(page, { total: 29 });
    await pickParty(page);
    await expect(chips(page, 'pm')).toHaveCount(4);
    expect(await ids(page, 'pm')).toEqual([C[0].id, C[3].id, C[5].id, C[7].id]);
    await expect(page.locator('.quick-reason', { hasText: 'פופולרי' })).toHaveCount(0);
  });

  test('exactly 30 votes enables popular', async ({ page }) => {
    await start(page, { total: 30 });
    await pickParty(page);
    await expect(chips(page, 'pm').first().locator('.quick-reason')).toHaveText('פופולרי · 46%');
  });

  test('ban window (no total) skips popular', async ({ page }) => {
    await start(page, { banned: true });
    await pickParty(page);
    await expect(chips(page, 'pm')).toHaveCount(4);
    await expect(page.locator('.quick-reason', { hasText: 'פופולרי' })).toHaveCount(0);
  });

  test('candidate picked in another role is excluded', async ({ page }) => {
    await start(page);
    await pickParty(page);
    await pick(page, 'defense', wordsOf(C[0])[0], C[0].id);
    await expect(page.locator(`#role-pm .quick-chip[data-cand="${C[0].id}"]`)).toHaveCount(0);
    expect(await ids(page, 'pm')).toEqual([C[1].id, C[2].id, C[3].id, C[5].id]);
  });

  test('tap fills the role, advances focus, hides chips; clear restores them', async ({ page }) => {
    await start(page);
    await pickParty(page);
    await chips(page, 'pm').nth(2).click();
    await expect(page.locator('#role-pm .picked')).toContainText(C[3].name);
    await expect(page.getByText(`1/${N}`)).toBeVisible();
    await expect(page.locator('#in-defense')).toBeFocused();
    await expect(page.locator('#role-pm .quick')).toBeHidden();
    await expect(page.locator(`#role-defense .quick-chip[data-cand="${C[3].id}"]`)).toHaveCount(0);
    await page.locator('#role-pm').getByRole('button', { name: /ניקוי/ }).click();
    await expect(chips(page, 'pm')).toHaveCount(4);
    expect(await ids(page, 'pm')).toEqual([C[0].id, C[1].id, C[3].id, C[5].id]);
  });

  test('empty suggestions and few votes: no chips, no errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await start(page, { suggestions: {}, total: 5 });
    await pickParty(page);
    await expect(page.locator('#in-pm')).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page.locator('.quick-chip')).toHaveCount(0);
    await expect(page.locator('.quick:visible')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('missing or malformed suggestions do not break the screen', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await start(page, { suggestions: { pm: 'oops', defense: [null, { candidateId: C[2].id }] }, total: 5 });
    await pickParty(page);
    await expect(chips(page, 'defense')).toHaveCount(1);
    await expect(chips(page, 'pm')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('results fetch failure: curated chips only, screen works', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockApi(page);
    await page.route('**/api/results**', (r) => r.abort());
    await page.goto('/');
    await pickParty(page);
    await expect(chips(page, 'pm')).toHaveCount(4);
    await expect(page.locator('.quick-reason', { hasText: 'פופולרי' })).toHaveCount(0);
    await chips(page, 'pm').first().click();
    await expect(page.getByText(`1/${N}`)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('chips cause no horizontal overflow at 360px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const long = { ...fixture, candidates: fixture.candidates.map((c) => ({ ...c, name: `${c.name} בן־אליעזר־וולפסון` })) };
    await start(page, { data: long });
    await pickParty(page);
    await expect(chips(page, 'pm')).toHaveCount(4);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
});
