import { readFileSync } from 'node:fs';

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
export const fixture = load('../test/fixtures/candidates.json');
export const realData = () => load('../data/candidates.json');
export const realSuggestions = () => load('../data/suggestions.json').roles;
export const i18n = (l) => load(`../public/i18n/${l}.json`);

export const roles = [
  ['pm', 'ראש הממשלה'], ['defense', 'שר הביטחון'], ['foreign', 'שר החוץ'], ['finance', 'שר האוצר'], ['justice', 'שר המשפטים'],
  ['transport', 'שר התחבורה'], ['education', 'שר החינוך'], ['sports', 'שר הספורט'], ['economy', 'שר הכלכלה'],
  ['hasbara', 'שר ההסברה'], ['religion', 'שר הדתות'], ['culture', 'שר התרבות'], ['national_security', 'השר לביטחון לאומי'],
].map(([id, name]) => ({ id, name }));

const TURNSTILE_STUB = `(() => {
  const w = window, widgets = {};
  let n = 0, tokens = 0;
  w.__ts = { renders: [], resets: 0, removes: 0 };
  const issue = (id) => setTimeout(() => widgets[id] && widgets[id].callback('token-' + (++tokens)), 30);
  w.turnstile = {
    render(el, opts) { const id = 'w' + (++n); widgets[id] = opts; w.__ts.renders.push(JSON.parse(JSON.stringify(opts))); issue(id); return id; },
    reset(id) { w.__ts.resets++; issue(id); },
    remove(id) { w.__ts.removes++; delete widgets[id]; },
    getResponse() {},
  };
  const cb = new URL(document.currentScript.src).searchParams.get('onload');
  if (cb) w[cb]();
})();`;

function results(data, party, banned, ties, empty, total) {
  const pool = party ? data.candidates.filter((c) => c.partyId === party) : data.candidates;
  const byRole = {};
  roles.forEach((r, i) => {
    byRole[r.id] = empty.includes(r.id) ? [] : [0, 1, 2].map((k) => {
      const pct = ties.includes(r.id) ? [37.5, 37.5, 9.6][k] : [46.3, 28.1, 9.6][k];
      const entry = { candidateId: pool[(i + k) % pool.length].id, pct };
      if (!banned) entry.count = Math.round(pct * 10);
      return entry;
    });
  });
  return banned ? { banned: true, byRole, ties } : { total, banned: false, byRole, ties };
}

export const REASONS = ['ניסיון בתחום', 'כיהן בתפקיד', 'מומחה מקצועי', 'בחירה מפתיעה'];

export function defaultSuggestions(data) {
  const n = data.candidates.length;
  return Object.fromEntries(roles.map((r, i) => [r.id, [
    { candidateId: data.candidates[i].id, reason: REASONS[0] },
    { candidateId: 'no-such-candidate', reason: 'לא קיים' },
    ...[3, 5, 7, 9].map((k, j) => ({ candidateId: data.candidates[(i + k) % n].id, reason: REASONS[j] })),
  ]]));
}

export async function mockApi(page, opts = {}) {
  const { data = fixture, status = { voted: false }, vote = 201, banned = false, ties = [], empty = [], total = 1000, suggestions, siteKey = 'test-site-key', fonts = false } = opts;
  const calls = { votes: [], voteHeaders: [], results: [] };
  if (!fonts) await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: TURNSTILE_STUB }));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (code, body) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    const isBanned = typeof banned === 'function' ? banned() : banned;
    switch (url.pathname) {
      case '/api/candidates':
        return json(200, { parties: data.parties, candidates: data.candidates, roles, turnstileSiteKey: siteKey, suggestions: suggestions ?? defaultSuggestions(data) });
      case '/api/status':
        return json(200, typeof status === 'function' ? status() : status);
      case '/api/vote': {
        const body = route.request().postDataJSON();
        calls.votes.push(body);
        calls.voteHeaders.push(await route.request().allHeaders());
        let res = typeof vote === 'function' ? vote(body) : vote;
        if (typeof res === 'number') res = [res, res === 201 ? { ok: true } : { error: { 400: 'invalid', 403: 'captcha', 409: 'already_voted', 429: 'rate_limited' }[res] }];
        return json(...res);
      }
      case '/api/results': {
        const party = url.searchParams.get('party');
        calls.results.push(party);
        return json(200, isBanned && party ? { banned: true } : results(data, party, isBanned, ties, empty, total));
      }
      default:
        return json(404, { error: 'not_found' });
    }
  });
  return calls;
}

export async function pickParty(page, partyId = fixture.parties[0].id) {
  await page.locator(`.party-card[data-party="${partyId}"]`).click();
  await page.getByRole('heading', { name: 'הרכיבו את הממשלה שלכם' }).waitFor();
}

export async function pick(page, roleId, query, candId) {
  const input = page.locator(`#in-${roleId}`);
  await input.click();
  await input.fill(query);
  await page.locator(`#lb-${roleId} [data-cand="${candId}"]`).click();
}

export async function fillAll(page, data = fixture) {
  const cands = data.candidates.slice(0, 13);
  for (const [i, r] of roles.entries()) await pick(page, r.id, cands[i].name.split(/\s+/)[0], cands[i].id);
}

export async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}
