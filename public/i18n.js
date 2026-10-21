export const LANGS = ['he', 'ru', 'fr'];
const LOCALES = { he: 'he-IL', ru: 'ru-RU', fr: 'fr-FR' };
const KEY = 'lang';

const HE = {
  title: 'נבחרת החלומות 2026',
  brand: 'נבחרת החלומות',
  brandSub: 'הבחירות לכנסת · 27.10.2026',
  langLabel: 'שפה',
  loading: 'טוען…',
  retry: 'נסו שוב',
  step1: 'שלב 1 מתוך 2',
  partyTitle: 'למי אתם מצביעים?',
  partyDesc: 'בחרו את המפלגה שלכם. הבחירה משמשת רק לפילוח התוצאות.',
  ballotLetters: 'אותיות הפתק',
  back: '→ שינוי מפלגה',
  step2: 'שלב 2 מתוך 2',
  cabinetTitle: 'הרכיבו את הממשלה שלכם',
  cabinetDesc: 'הקלידו שם ובחרו מהרשימה. כל מועמד יכול לכהן בתפקיד אחד בלבד.',
  progress: 'התקדמות',
  placeholder: 'הקלידו שם מועמד…',
  candidatesFor: 'מועמדים לתפקיד {role}',
  quickFor: 'בחירות מהירות לתפקיד {role}',
  quickPick: 'בחירה מהירה: {details}, לתפקיד {role}',
  popular: 'פופולרי',
  noMatches: 'לא נמצאו מועמדים',
  clearFor: 'ניקוי הבחירה לתפקיד {role}',
  left: { one: 'נותר תפקיד אחד', other: 'נותרו {n} תפקידים' },
  ready: 'הכול מוכן!',
  submit: 'שליחת הנבחרת שלי',
  sending: 'שולח…',
  results: 'תוצאות',
  disclaimer: 'זהו אינו סקר מדעי. התוצאות מבוססות על הצבעות גולשים באתר, אינן מבוססות על שיטה סטטיסטית ואין להסיק מהן על דפוסי הצבעה.',
  mine: 'הנבחרת שלי',
  share: 'שתפו את הנבחרת שלי',
  download: 'שמירת התמונה',
  ad: 'פרסומת',
  majority: 'נבחרת הרוב',
  tabsLabel: 'סינון לפי מפלגה',
  all: 'כולם',
  banNote: 'פילוח לפי מפלגות יחזור עם סגירת הקלפיות (27.10, 22:00)',
  votes: { one: '{n} הצבעה', other: '{n} הצבעות' },
  govTable: 'שולחן הממשלה',
  likeYou: '{pct} כמוך',
  likeYouSr: '{pct} בחרו כמוך',
  matchSr: 'כמו הבחירה שלך',
  noVotes: 'אין עדיין הצבעות',
  tie: 'תיקו',
  shareText: 'זו נבחרת החלומות שלי לממשלה הבאה. ושלך? בואו לבחור: ',
  imgTitle: 'נבחרת החלומות שלי',
  imgDate: 'בחירות 27.10.2026',
  network: 'אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.',
  rate: 'נשלחו יותר מדי הצבעות מהרשת שלכם היום. נסו שוב מחר.',
  invalid: 'ההצבעה לא תקינה. רעננו את הדף ונסו שוב.',
  generic: 'אירעה שגיאה. נסו שוב בעוד רגע.',
  load: 'לא הצלחנו לטעון את הנתונים.',
  loadRetry: 'לא הצלחנו לטעון את הנתונים. נסו שוב בעוד רגע.',
  captcha: 'אימות האבטחה נכשל. נסו לשלוח שוב.',
  captchaLoad: 'לא הצלחנו לטעון את אימות האבטחה. בדקו את החיבור ורעננו את הדף.',
  shareFailed: 'השיתוף לא הצליח. אפשר לשמור את התמונה ולשתף ידנית.',
};

let lang = 'he';
let pack = {};
const packs = new Map();

export const getLang = () => lang;
export const locale = () => LOCALES[lang];
export const dir = (l = lang) => (l === 'he' ? 'rtl' : 'ltr');

export function initialLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) return q;
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* storage unavailable */ }
  return 'he';
}

export async function setLang(l) {
  if (!LANGS.includes(l)) l = 'he';
  if (l !== 'he' && !packs.has(l)) {
    const res = await fetch(`/i18n/${l}.json`);
    if (!res.ok) throw new Error(`i18n ${res.status}`);
    packs.set(l, await res.json());
  }
  lang = l;
  pack = l === 'he' ? {} : packs.get(l);
  try { localStorage.setItem(KEY, l); } catch { /* storage unavailable */ }
}

export function t(key, vars = {}) {
  let v = pack.ui?.[key] ?? HE[key] ?? key;
  if (typeof v === 'object') v = v[new Intl.PluralRules(LOCALES[lang]).select(Number(vars.count ?? vars.n ?? 0))] ?? v.other;
  return String(v).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

export const candName = (c) => pack.candidates?.[c.id] || c.name;
export const partyLabel = (p) => (p && (pack.parties?.[p.id] || p.name)) || '';
export const roleName = (r) => pack.roles?.[r.id]?.name || r.name;
export const roleShort = (r, heShort) => pack.roles?.[r.id]?.short || heShort || r.name;
export const reasonText = (roleId, candId, he) => pack.reasons?.[`${roleId}:${candId}`] || he;

export function fmtNumber(n) {
  return Number(n).toLocaleString(LOCALES[lang]);
}

export function fmtPct(n, digits = 1) {
  return (Number(n) / 100).toLocaleString(LOCALES[lang], { style: 'percent', maximumFractionDigits: digits });
}
