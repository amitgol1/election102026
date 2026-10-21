import { normalize, words, matches } from './search.js';
import { renderShareImage } from './share.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const MSG = {
  network: 'אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.',
  rate: 'נשלחו יותר מדי הצבעות מהרשת שלכם היום. נסו שוב מחר.',
  invalid: 'ההצבעה לא תקינה. רעננו את הדף ונסו שוב.',
  generic: 'אירעה שגיאה. נסו שוב בעוד רגע.',
  load: 'לא הצלחנו לטעון את הנתונים.',
  captcha: 'אימות האבטחה נכשל. נסו לשלוח שוב.',
  share: 'השיתוף לא הצליח. אפשר לשמור את התמונה ולשתף ידנית.',
  captchaLoad: 'לא הצלחנו לטעון את אימות האבטחה. בדקו את החיבור ורעננו את הדף.',
};

const state = {
  parties: [],
  roles: [],
  candidates: [],
  partyById: new Map(),
  candById: new Map(),
  partyId: null,
  picks: {},
  allResults: null,
  banned: false,
  tab: '',
  voted: false,
  pushed: false,
  siteKey: null,
  token: null,
  widgetId: null,
  suggestions: {},
  popular: {},
  popularLoading: null,
  shareKey: '',
  shareFile: null,
  shareReady: null,
};

const DRAFT_KEY = 'draft';

function saveDraft() {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ partyId: state.partyId, picks: state.picks })); } catch { /* storage unavailable */ }
}

function loadDraft() {
  try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
}

function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
}

function restoreDraft() {
  const d = loadDraft();
  if (!d) return;
  if (state.partyById.has(d.partyId)) state.partyId = d.partyId;
  const used = new Set();
  for (const r of state.roles) {
    const id = d.picks?.[r.id];
    if (state.candById.has(id) && !used.has(id)) {
      state.picks[r.id] = id;
      used.add(id);
    }
  }
}

const TS_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
let tsLoading = null;
let tokenWaiters = [];

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  tsLoading ||= new Promise((resolve, reject) => {
    window.onTurnstileLoad = () => resolve(window.turnstile);
    const script = el('script', { src: TS_URL, async: true });
    script.onerror = () => { tsLoading = null; script.remove(); reject(new Error('turnstile')); };
    document.head.append(script);
  });
  return tsLoading;
}

function setToken(t) {
  state.token = t;
  if (t) { tokenWaiters.forEach((w) => w(t)); tokenWaiters = []; }
}

async function ensureTurnstile() {
  if (!state.siteKey || state.widgetId != null) return;
  const ts = await loadTurnstile();
  if (state.widgetId != null) return;
  state.widgetId = ts.render('#captcha', {
    sitekey: state.siteKey,
    language: 'he',
    size: 'flexible',
    appearance: 'interaction-only',
    theme: 'light',
    callback: setToken,
    'expired-callback': () => setToken(null),
    'error-callback': () => setToken(null),
  });
}

function resetTurnstile() {
  setToken(null);
  if (state.widgetId != null) window.turnstile?.reset(state.widgetId);
}

function removeTurnstile() {
  if (state.widgetId != null) window.turnstile?.remove(state.widgetId);
  state.widgetId = null;
  setToken(null);
}

async function getToken(ms = 20000) {
  if (state.token) return state.token;
  await ensureTurnstile();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { tokenWaiters = tokenWaiters.filter((w) => w !== done); resolve(null); }, ms);
    const done = (t) => { clearTimeout(timer); resolve(t); };
    tokenWaiters.push(done);
  });
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const VOTER_KEY = 'voterId';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memVoterId = null;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function voterId() {
  try {
    let id = localStorage.getItem(VOTER_KEY);
    if (!id || !UUID_RE.test(id)) {
      id = uuid();
      localStorage.setItem(VOTER_KEY, id);
    }
    return id;
  } catch {
    return (memVoterId ||= uuid());
  }
}

class NetError extends Error {}

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      signal: ctrl.signal,
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    });
  } catch {
    throw new NetError();
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, 6000);
}

function show(id) {
  for (const s of document.querySelectorAll('.screen')) {
    if (s.id !== id) { s.hidden = true; s.classList.remove('enter'); }
  }
  const screen = $(`#${id}`);
  screen.hidden = false;
  screen.classList.remove('enter');
  void screen.offsetWidth;
  screen.classList.add('enter');
  window.scrollTo({ top: 0 });
  const heading = $('h2', screen);
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

function go(name, how = 'push') {
  show(`screen-${name}`);
  if (how === 'push') { history.pushState({ screen: name }, ''); state.pushed = true; }
  else if (how === 'replace') history.replaceState({ screen: name }, '');
  if (name === 'cabinet') {
    ensureTurnstile().catch(() => {});
    loadPopular();
  }
}

window.addEventListener('popstate', (e) => {
  if (!state.parties.length) return;
  if (state.voted) return go('results', 'replace');
  go(e.state?.screen === 'cabinet' && state.partyId ? 'cabinet' : 'party', null);
});

function fatal(msg, retry) {
  $('#fatal-msg').textContent = msg;
  $('#retry').onclick = retry;
  show('screen-error');
}

function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#111' : '#fff';
}

function initials(name) {
  const w = String(name).replace(/["'׳״]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return w.length === 1 ? w[0][0] : w[0][0] + w[w.length - 1][0];
}

function avatar(c, size = '') {
  const party = state.partyById.get(c.partyId);
  const color = party?.color || '#6b7280';
  const box = el('span', { className: `avatar ${size}` });
  box.setAttribute('aria-hidden', 'true');
  box.style.setProperty('--party', color);
  box.style.color = textOn(color);
  if (c.photo) {
    box.append(el('img', { src: c.photo, alt: '', loading: 'lazy', decoding: 'async', onerror() { this.replaceWith(initials(c.name)); } }));
  } else {
    box.textContent = initials(c.name);
  }
  return box;
}

function partyChip(partyId) {
  const p = state.partyById.get(partyId);
  const chip = el('span', { className: 'chip' }, el('span', { className: 'dot' }), p?.name || '');
  chip.style.setProperty('--party', p?.color || '#6b7280');
  return chip;
}

function candidateBody(c, nameNode) {
  return el('span', { className: 'cand-body' },
    el('span', { className: 'cand-name' }, nameNode || c.name),
    partyChip(c.partyId));
}

function renderParties() {
  const list = $('#party-list');
  list.replaceChildren();
  for (const p of state.parties) {
    const btn = el('button', { type: 'button', className: 'party-card' },
      el('span', { className: 'party-swatch' }),
      el('span', { className: 'party-name' }, p.name),
      p.letters ? el('span', { className: 'party-letters', title: 'אותיות הפתק' }, p.letters) : null);
    btn.style.setProperty('--party', p.color);
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(p.id === state.partyId));
    btn.dataset.party = p.id;
    btn.addEventListener('click', () => {
      state.partyId = p.id;
      saveDraft();
      for (const b of list.children) b.setAttribute('aria-checked', String(b === btn));
      setTimeout(() => go('cabinet'), reduceMotion.matches ? 0 : 180);
    });
    list.append(btn);
  }
}

const combos = new Map();

function highlight(name, query) {
  const q = words(query);
  if (!q.length || normalize(name).length !== name.length) return name;
  const frag = document.createDocumentFragment();
  const norm = normalize(name);
  const marks = new Array(name.length).fill(false);
  const re = /[^\s־\-–—.,()]+/g;
  let m;
  const used = new Set();
  while ((m = re.exec(norm))) {
    const qi = q.findIndex((x, i) => !used.has(i) && m[0].startsWith(x));
    if (qi >= 0) {
      used.add(qi);
      marks.fill(true, m.index, m.index + q[qi].length);
    }
  }
  let i = 0;
  while (i < name.length) {
    const on = marks[i];
    let j = i;
    while (j < name.length && marks[j] === on) j++;
    const part = name.slice(i, j);
    frag.append(on ? el('mark', {}, part) : part);
    i = j;
  }
  return frag;
}

function availableFor(roleId) {
  const taken = new Set(Object.entries(state.picks).filter(([r]) => r !== roleId).map(([, c]) => c));
  return state.candidates.filter((c) => !taken.has(c.id));
}

function buildCombo(role, index) {
  const id = role.id;
  const input = el('input', {
    id: `in-${id}`,
    type: 'text',
    className: 'combo-input',
    placeholder: 'הקלידו שם מועמד…',
    autocomplete: 'off',
    spellcheck: false,
  });
  Object.entries({
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': `lb-${id}`,
    autocapitalize: 'off',
    autocorrect: 'off',
    enterkeyhint: 'next',
  }).forEach(([k, v]) => input.setAttribute(k, v));

  const listbox = el('ul', { id: `lb-${id}`, className: 'listbox', hidden: true });
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-label', `מועמדים לתפקיד ${role.name}`);

  const picked = el('div', { className: 'picked', hidden: true });
  const idx = el('span', { className: 'role-idx' }, String(index + 1));
  idx.setAttribute('aria-hidden', 'true');
  const li = el('li', { className: 'role', id: `role-${id}` },
    el('label', { className: 'role-label', htmlFor: `in-${id}` }, idx, role.name),
    el('div', { className: 'combo' }, input, picked, listbox));
  li.dataset.role = id;
  const quick = el('div', { className: 'quick', hidden: true });
  quick.setAttribute('role', 'group');
  quick.setAttribute('aria-label', `בחירות מהירות לתפקיד ${role.name}`);
  li.append(quick);

  const c = { role, input, listbox, picked, li, quick, items: [], active: -1 };
  combos.set(id, c);

  input.addEventListener('focus', () => {
    document.body.classList.add('typing');
    open(c);
    setTimeout(() => {
      if (document.activeElement !== input) return;
      li.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
      setTimeout(() => fitList(c), 350);
    }, 250);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== input) {
        close(c);
        if (!document.activeElement?.classList?.contains('combo-input')) document.body.classList.remove('typing');
      }
    }, 120);
  });
  input.addEventListener('input', () => { c.active = input.value.trim() ? 0 : -1; open(c); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (listbox.hidden) open(c);
      const n = c.items.length;
      if (!n) return;
      c.active = e.key === 'ArrowDown' ? (c.active + 1) % n : (c.active - 1 + n) % n;
      paintActive(c);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cand = c.items[c.active] || (c.items.length === 1 ? c.items[0] : null);
      if (cand) choose(c, cand);
    } else if (e.key === 'Escape') {
      close(c);
    }
  });
  listbox.addEventListener('mousedown', (e) => e.preventDefault());
  listbox.addEventListener('click', (e) => {
    const opt = e.target.closest('[role=option]');
    if (opt) choose(c, state.candById.get(opt.dataset.cand));
  });
  return li;
}

function open(c) {
  const q = c.input.value;
  const nq = words(q);
  c.items = availableFor(c.role.id)
    .filter((cand) => matches(cand._w, q))
    .map((cand, order) => ({ cand, order, rank: nq.length && !cand._w[0].startsWith(nq[0]) ? 1 : 0 }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((x) => x.cand);
  if (c.active >= c.items.length) c.active = c.items.length - 1;
  c.listbox.replaceChildren();
  if (!c.items.length) {
    const empty = el('li', { className: 'empty' }, 'לא נמצאו מועמדים');
    empty.setAttribute('role', 'presentation');
    c.listbox.append(empty);
  }
  c.items.forEach((cand, i) => {
    const opt = el('li', { id: `opt-${c.role.id}-${cand.id}`, className: 'option' },
      avatar(cand), candidateBody(cand, highlight(cand.name, q)));
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', String(i === c.active));
    opt.dataset.cand = cand.id;
    c.listbox.append(opt);
  });
  c.listbox.hidden = false;
  c.input.setAttribute('aria-expanded', 'true');
  paintActive(c);
  fitList(c);
}

function paintActive(c) {
  [...c.listbox.querySelectorAll('[role=option]')].forEach((o, i) => {
    const on = i === c.active;
    o.setAttribute('aria-selected', String(on));
    o.classList.toggle('active', on);
    if (on) o.scrollIntoView({ block: 'nearest' });
  });
  const act = c.items[c.active];
  if (act) c.input.setAttribute('aria-activedescendant', `opt-${c.role.id}-${act.id}`);
  else c.input.removeAttribute('aria-activedescendant');
}

function fitList(c) {
  if (c.listbox.hidden) return;
  const vv = window.visualViewport;
  const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const top = c.input.getBoundingClientRect().bottom;
  const avail = Math.floor(bottom - top - 12);
  c.listbox.style.maxHeight = `${Math.max(140, Math.min(avail, 320))}px`;
}

function close(c) {
  c.listbox.hidden = true;
  c.input.setAttribute('aria-expanded', 'false');
  c.input.removeAttribute('aria-activedescendant');
  c.active = -1;
}

function choose(c, cand) {
  state.picks[c.role.id] = cand.id;
  saveDraft();
  c.input.value = '';
  close(c);
  renderPicked(c);
  updateProgress();
  renderAllQuick();
  const next = state.roles.find((r) => !state.picks[r.id]);
  if (next) combos.get(next.id).input.focus();
  else {
    document.body.classList.remove('typing');
    $('#submit').scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }
}

function clearPick(c) {
  delete state.picks[c.role.id];
  saveDraft();
  renderPicked(c);
  updateProgress();
  renderAllQuick();
  c.input.focus();
}

function renderPicked(c) {
  const cand = state.candById.get(state.picks[c.role.id]);
  c.li.classList.toggle('filled', !!cand);
  c.input.hidden = !!cand;
  c.picked.hidden = !cand;
  c.picked.replaceChildren();
  if (!cand) return;
  const clear = el('button', { type: 'button', className: 'clear-btn', textContent: '×' });
  clear.setAttribute('aria-label', `ניקוי הבחירה לתפקיד ${c.role.name}`);
  clear.addEventListener('click', () => clearPick(c));
  c.picked.append(avatar(cand), candidateBody(cand), clear);
  c.picked.classList.remove('pop');
  void c.picked.offsetWidth;
  c.picked.classList.add('pop');
}

function updateProgress() {
  const total = state.roles.length;
  const done = state.roles.filter((r) => state.picks[r.id]).length;
  $('#progress-text').textContent = `${done}/${total}`;
  $('#progress-fill').style.transform = `scaleX(${total ? done / total : 0})`;
  $('#submit').disabled = done !== total;
  const left = total - done;
  $('#submit-hint').textContent = left ? (left === 1 ? 'נותר תפקיד אחד' : `נותרו ${left} תפקידים`) : 'הכול מוכן!';
}

function renderCabinet() {
  const ol = $('#roles');
  ol.replaceChildren();
  combos.clear();
  state.roles.forEach((r, i) => ol.append(buildCombo(r, i)));
  for (const c of combos.values()) renderPicked(c);
  updateProgress();
  renderAllQuick();
}

const POPULAR_MIN_TOTAL = 30;

function loadPopular() {
  state.popularLoading ||= loadResults('')
    .then((res) => {
      state.popular = typeof res.total === 'number' && res.total >= POPULAR_MIN_TOTAL ? res.byRole || {} : {};
      renderAllQuick();
    })
    .catch(() => { state.popularLoading = null; });
}

function quickPicks(roleId) {
  const taken = new Set(Object.entries(state.picks).filter(([r]) => r !== roleId).map(([, id]) => id));
  const usable = (id) => state.candById.has(id) && !taken.has(id);
  const out = [];
  const seen = new Set();
  const add = (id, label, reason) => {
    if (out.length >= 4 || seen.has(id) || !usable(id)) return;
    seen.add(id);
    out.push({ cand: state.candById.get(id), label, reason });
  };
  const popular = (Array.isArray(state.popular[roleId]) ? state.popular[roleId] : [])
    .filter((e) => usable(e?.candidateId)).slice(0, 2);
  for (const e of popular) add(e.candidateId, `פופולרי · ${Math.round(e.pct)}%`, 'פופולרי');
  const curated = Array.isArray(state.suggestions[roleId]) ? state.suggestions[roleId] : [];
  for (const s of curated) {
    const reason = typeof s?.reason === 'string' ? s.reason.trim() : '';
    add(s?.candidateId, reason, reason);
  }
  return out;
}

function renderQuick(c) {
  const picks = state.picks[c.role.id] ? [] : quickPicks(c.role.id);
  c.quick.replaceChildren();
  c.quick.hidden = !picks.length;
  for (const { cand, label, reason } of picks) {
    const chip = el('button', { type: 'button', className: 'quick-chip' },
      avatar(cand, 'xs'),
      el('span', { className: 'quick-text' },
        el('span', { className: 'quick-name' }, cand.name),
        label ? el('span', { className: 'quick-reason' }, label) : null));
    chip.dataset.cand = cand.id;
    chip.setAttribute('aria-label', `בחירה מהירה: ${cand.name}${reason ? `, ${reason}` : ''}, לתפקיד ${c.role.name}`);
    chip.addEventListener('click', () => choose(c, cand));
    c.quick.append(chip);
  }
}

function renderAllQuick() {
  for (const c of combos.values()) renderQuick(c);
}

async function submit(e) {
  e.preventDefault();
  const btn = $('#submit');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = 'שולח…';
  try {
    let turnstileToken;
    if (state.siteKey) {
      try {
        turnstileToken = await getToken();
      } catch {
        return toast(MSG.captchaLoad);
      }
      if (!turnstileToken) return toast(MSG.captcha);
    }
    const { status, body } = await api('/api/vote', {
      method: 'POST',
      body: JSON.stringify({ voterId: voterId(), partyId: state.partyId, picks: state.picks, turnstileToken }),
    });
    if (status === 201 || status === 200) { removeTurnstile(); return showResults(); }
    if (status === 409) { removeTurnstile(); return showResults(await fetchStatus()); }
    resetTurnstile();
    if (status === 403 && body.error === 'captcha') toast(MSG.captcha);
    else toast(status === 429 ? MSG.rate : status === 400 ? MSG.invalid : MSG.generic);
  } catch (err) {
    resetTurnstile();
    toast(err instanceof NetError ? MSG.network : MSG.generic);
  } finally {
    btn.classList.remove('busy');
    btn.textContent = 'שליחת הנבחרת שלי';
    updateProgress();
  }
}

async function fetchStatus() {
  try {
    const { status, body } = await api(`/api/status?voterId=${encodeURIComponent(voterId())}`);
    return status === 200 ? body : null;
  } catch {
    return null;
  }
}

const ROWS = [['pm'], ['defense', 'finance', 'foreign', 'justice'], ['transport', 'education', 'national_security', 'economy'], ['sports', 'hasbara', 'religion', 'culture']];
const FORMATION = ROWS.flat();
const GRID_COLS = 64;
const ROW_SPANS = [GRID_COLS, 14, 15, 16];

function seat(li, roleId) {
  let row = ROWS.findIndex((r) => r.includes(roleId));
  let pos;
  if (row < 0) {
    const k = state.roles.map((r) => r.id).filter((id) => !FORMATION.includes(id)).indexOf(roleId);
    row = ROWS.length + Math.floor(k / 4);
    pos = k % 4;
  } else pos = ROWS[row].indexOf(roleId);
  li.style.gridRow = String(row + 1);
  if (row === 0) return;
  const span = ROW_SPANS[Math.min(row, ROW_SPANS.length - 1)];
  li.style.gridColumn = `${(GRID_COLS - span * 4) / 2 + pos * span + 1} / span ${span}`;
  li.classList.add(pos === 0 ? 'seat-start' : pos === 3 ? 'seat-end' : 'seat-inner');
}
const SHORT = {
  pm: 'ראש הממשלה', defense: 'ביטחון', finance: 'אוצר', foreign: 'חוץ', justice: 'משפטים',
  transport: 'תחבורה', education: 'חינוך', national_security: 'בט"ל', economy: 'כלכלה',
  sports: 'ספורט', hasbara: 'הסברה', religion: 'דתות', culture: 'תרבות',
};

function plenumRoles() {
  const rank = (r) => { const i = FORMATION.indexOf(r.id); return i < 0 ? FORMATION.length : i; };
  return [...state.roles].sort((a, b) => rank(a) - rank(b));
}

const partyName = (cand) => state.partyById.get(cand.partyId)?.name || '';

function player(role, i, { cands = [], pills = [], match = false, sr }) {
  const li = el('li', { className: `player${role.id === 'pm' ? ' pm' : ''}${cands.length > 1 ? ' tie' : ''}`, title: role.name });
  li.dataset.role = role.id;
  li.style.setProperty('--i', String(i));
  seat(li, role.id);
  const avatars = el('span', { className: 'player-avatars' });
  if (cands.length) cands.forEach((c) => avatars.append(avatar(c)));
  else avatars.append(el('span', { className: 'avatar empty' }, '—'));
  if (match) avatars.append(el('span', { className: 'player-check' }, '✓'));
  if (role.id === 'pm') avatars.append(el('span', { className: 'gov-table' }, 'שולחן הממשלה'));
  const names = el('span', { className: 'player-names' },
    ...(cands.length ? cands.map((c) => el('span', { className: 'player-name' }, c.name)) : []));
  const parties = el('span', { className: 'player-party' }, cands.map(partyName).join(' / '));
  const vis = el('span', { className: 'player-vis' },
    el('span', { className: 'player-role' }, SHORT[role.id] || role.name),
    avatars, names, cands.length ? parties : null,
    ...pills.map(([cls, text]) => el('span', { className: `pill ${cls}` }, text)));
  vis.setAttribute('aria-hidden', 'true');
  li.append(el('span', { className: 'visually-hidden' }, sr), vis);
  if (cands.length) li.addEventListener('click', () => li.classList.toggle('open'));
  return li;
}

function renderMine() {
  const list = $('#mine-list');
  list.replaceChildren();
  const has = state.roles.some((r) => state.picks[r.id]);
  $('#mine-block').hidden = !has;
  if (!has) return;
  const all = state.allResults;
  plenumRoles().forEach((r, i) => {
    const cand = state.candById.get(state.picks[r.id]);
    if (!cand) return;
    const hit = all?.byRole?.[r.id]?.find((x) => x.candidateId === cand.id);
    list.append(player(r, i, {
      cands: [cand],
      pills: hit ? [['agree', `${fmtPct(hit.pct)} כמוך`]] : [],
      sr: `${r.name}: ${cand.name}, ${partyName(cand)}${hit ? `, ${fmtPct(hit.pct)} בחרו כמוך` : ''}`,
    }));
  });
  prepareShare();
}

const fmtPct = (n) => `${Number(n).toLocaleString('he-IL', { maximumFractionDigits: 1 })}%`;

function renderTabs() {
  const tabs = $('#tabs');
  tabs.replaceChildren();
  const items = [{ id: '', name: 'כולם' }, ...(state.banned ? [] : state.parties)];
  for (const p of items) {
    const t = el('button', { type: 'button', className: 'tab', id: `tab-${p.id || 'all'}` }, p.id ? el('span', { className: 'dot' }) : null, p.name);
    if (p.id) t.style.setProperty('--party', p.color);
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-selected', String(p.id === state.tab));
    t.setAttribute('aria-controls', 'majority-panel');
    t.tabIndex = p.id === state.tab ? 0 : -1;
    t.dataset.party = p.id;
    t.addEventListener('click', () => selectTab(p.id));
    tabs.append(t);
  }
  $('#ban-note').hidden = !state.banned;
}

$('#tabs').addEventListener('keydown', (e) => {
  const keys = { ArrowLeft: 1, ArrowRight: -1, Home: 'first', End: 'last' };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const tabs = [...$('#tabs').children];
  const i = tabs.indexOf(document.activeElement);
  const k = keys[e.key];
  const next = k === 'first' ? tabs[0] : k === 'last' ? tabs.at(-1) : tabs[(i + k + tabs.length) % tabs.length];
  next.focus();
  next.click();
});

async function loadResults(party) {
  const { status, body } = await api(`/api/results${party ? `?party=${encodeURIComponent(party)}` : ''}`);
  if (status !== 200) throw new Error(String(status));
  return body;
}

function setBanned(banned) {
  state.banned = banned;
  if (banned) state.tab = '';
  renderTabs();
}

let tabSeq = 0;

async function selectTab(party) {
  const seq = ++tabSeq;
  state.tab = party;
  for (const t of $('#tabs').children) {
    const on = t.dataset.party === party;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  $('#majority-panel').setAttribute('aria-labelledby', `tab-${party || 'all'}`);
  const list = $('#majority-list');
  list.classList.add('loading');
  try {
    const res = await loadResults(party);
    if (seq !== tabSeq) return;
    if (res.banned && party) {
      setBanned(true);
      return selectTab('');
    }
    if (!party) {
      state.allResults = res;
      if (!!res.banned !== state.banned || !$('#tabs').children.length) setBanned(!!res.banned);
      renderMine();
    }
    renderMajority(res);
  } catch (err) {
    if (seq !== tabSeq) return;
    const retry = el('button', { type: 'button', className: 'btn btn-ghost' }, 'נסו שוב');
    retry.addEventListener('click', () => selectTab(party));
    list.replaceChildren(el('li', { className: 'empty-state' }, el('p', {}, err instanceof NetError ? MSG.network : MSG.load), retry));
  } finally {
    list.classList.remove('loading');
  }
}

function renderMajority(res) {
  const list = $('#majority-list');
  list.replaceChildren();
  $('#total').textContent = typeof res.total === 'number' ? `${res.total.toLocaleString('he-IL')} הצבעות` : '';
  const ties = new Set(res.ties || []);
  plenumRoles().forEach((r, i) => {
    const entries = res.byRole?.[r.id] || [];
    const tied = ties.has(r.id) && entries.length > 1;
    const leaders = (tied ? entries.slice(0, 2) : entries.slice(0, 1))
      .map((e) => ({ e, cand: state.candById.get(e.candidateId) }))
      .filter((x) => x.cand);
    if (!leaders.length) {
      list.append(player(r, i, { sr: `${r.name}: אין עדיין הצבעות` }));
      return;
    }
    const pct = fmtPct(leaders[0].e.pct);
    const match = leaders.some((x) => state.picks[r.id] === x.cand.id);
    const who = leaders.map((x) => `${x.cand.name}, ${partyName(x.cand)}`).join('; ');
    list.append(player(r, i, {
      cands: leaders.map((x) => x.cand),
      match,
      pills: [...(leaders.length > 1 ? [['tie-pill', 'תיקו']] : []), ['pct', pct]],
      sr: `${r.name}: ${leaders.length > 1 ? 'תיקו — ' : ''}${who}, ${pct}${match ? ', כמו הבחירה שלך' : ''}`,
    }));
  });
}

const SHARE_TEXT = 'זו נבחרת החלומות שלי לממשלה הבאה. ושלך? בואו לבחור: ';
const SHARE_NAME = 'nivheret-hachalomot.png';

function prepareShare() {
  const key = JSON.stringify(state.picks);
  if (key === state.shareKey) return;
  state.shareKey = key;
  state.shareFile = null;
  const link = $('#share-download');
  link.hidden = true;
  if (link.href.startsWith('blob:')) URL.revokeObjectURL(link.href);
  link.removeAttribute('href');
  state.shareReady = renderShareImage({
    roles: state.roles,
    picks: state.picks,
    rows: ROWS,
    short: SHORT,
    host: location.host,
    helpers: {
      cand: (id) => state.candById.get(id),
      partyColor: (c) => state.partyById.get(c.partyId)?.color,
      textOn,
      initials,
    },
  }).then((blob) => {
    if (state.shareKey !== key) return null;
    state.shareFile = new File([blob], SHARE_NAME, { type: 'image/png' });
    link.href = URL.createObjectURL(blob);
    return state.shareFile;
  }).catch(() => null);
}

function offerDownload() {
  const link = $('#share-download');
  link.hidden = false;
  if (!link.href) state.shareReady?.then(() => { link.hidden = false; });
}

function shareFailed(err) {
  if (err?.name === 'AbortError') return;
  toast(MSG.share);
  offerDownload();
}

async function share() {
  const text = SHARE_TEXT + location.origin + '/';
  const file = state.shareFile || await state.shareReady;
  try {
    if (file && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text });
    } else if (navigator.share) {
      offerDownload();
      await navigator.share({ text });
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      offerDownload();
    }
  } catch (err) {
    shareFailed(err);
  }
}

async function showResults(status) {
  if (status?.picks) state.picks = { ...status.picks };
  if (status?.partyId) state.partyId = status.partyId;
  state.voted = true;
  clearDraft();
  state.allResults = null;
  state.tab = '';
  state.banned = false;
  $('#tabs').replaceChildren();
  $('#ban-note').hidden = true;
  go('results', 'replace');
  renderMine();
  await selectTab('');
}

async function boot() {
  show('screen-loading');
  let data;
  const [st, cands] = await Promise.allSettled([fetchStatus(), api('/api/candidates')]);
  if (cands.status === 'fulfilled' && cands.value.status === 200) data = cands.value.body;
  if (!data) {
    const net = cands.status === 'rejected' && cands.reason instanceof NetError;
    return fatal(net ? MSG.network : `${MSG.load} נסו שוב בעוד רגע.`, boot);
  }
  state.siteKey = data.turnstileSiteKey || null;
  state.suggestions = data.suggestions && typeof data.suggestions === 'object' ? data.suggestions : {};
  state.parties = data.parties || [];
  state.roles = data.roles || [];
  state.candidates = (data.candidates || []).map((c) => ({ ...c, _w: words(c.name) }));
  state.partyById = new Map(state.parties.map((p) => [p.id, p]));
  state.candById = new Map(state.candidates.map((c) => [c.id, c]));
  const status = st.status === 'fulfilled' ? st.value : null;
  if (!status?.voted) restoreDraft();
  renderParties();
  renderCabinet();
  if (status?.voted) return showResults(status);
  go(history.state?.screen === 'cabinet' && state.partyId ? 'cabinet' : 'party', 'replace');
}

$('#cabinet-form').addEventListener('submit', submit);
$('#share-btn').addEventListener('click', share);
$('#back-party').addEventListener('click', () => (state.pushed ? history.back() : go('party', 'replace')));
window.visualViewport?.addEventListener('resize', () => {
  for (const c of combos.values()) fitList(c);
});

boot();
