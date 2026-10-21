# Spec — נבחרת החלומות 2026

Mobile-first (iOS Safari, Android Chrome), Hebrew, RTL. Election: 2026-10-27.

## Flow
1. Party screen: voter picks the party they vote for.
2. Cabinet screen: 13 roles; each is an autocomplete input (prefix match on any word of the name, Hebrew, ignoring niqqud/quotes) over all candidates of all parties. A candidate already picked for one role is excluded from the others. Submit enabled only when all 13 are filled.
   Quick picks: under each role, up to 4 suggestion chips — first up to 2 "פופולרי" (overall top picks from GET /api/results, only when total >= 30), then curated suggestions with their reason; skip candidates already picked in another role; tap = pick. Search stays as is.
3. Results screen: my cabinet vs. majority cabinet (top candidate per role with %), tabs: "כולם" + one per party.
   Both cabinets are drawn as a Knesset plenum (horseshoe of seats, government table at the front; replaces the lists), rows top→bottom:
   1. pm
   2. defense · finance · foreign · justice
   3. transport · education · national_security · economy
   4. sports · hasbara · religion · culture
   Majority pitch cards show pct; a tied role shows "תיקו" with both names.
4. A returning voter (voterId already voted) goes straight to results.
5. Share (results screen, under "הנבחרת שלי"): button "שתפו את הנבחרת שלי" builds a PNG of MY cabinet (plenum style, 1080x1350) client-side and opens the native share sheet with the image + text:
   "זו נבחרת החלומות שלי לממשלה הבאה. ושלך? בואו לבחור: <site URL>"
   Fallbacks: no file-share support → share text+link only, plus "שמירת התמונה" download; no Web Share → WhatsApp link (wa.me/?text=) + download. Page has og:title/og:description for link previews.

## Roles (fixed order, ids)
pm ראש הממשלה · defense שר הביטחון · foreign שר החוץ · finance שר האוצר · justice שר המשפטים · transport שר התחבורה · education שר החינוך · sports שר הספורט · economy שר הכלכלה · hasbara שר ההסברה · religion שר הדתות · culture שר התרבות · national_security השר לביטחון לאומי

## Data — data/candidates.json
{
  "parties": [{ "id": "likud", "name": "הליכוד", "letters": "מחל", "seats": 21, "color": "#1f4e9c" }],
  "candidates": [{ "id": "likud-1", "partyId": "likud", "name": "…", "slot": 1, "photo": null }]
}
Only realistic candidates are in the file (slot <= party seats in poll average). photo optional; UI falls back to initials.

## API
GET  /api/candidates → 200 { parties, candidates, roles: [{id,name}], turnstileSiteKey, suggestions: { roleId: [{ candidateId, reason }] } } — from data/suggestions.json, ordered
POST /api/vote  body { voterId: uuid-v4, partyId, picks: {roleId: candidateId}, turnstileToken }
  Requires Content-Type application/json, same-origin Origin (exact match), body <= 4KB.
  201 { ok: true }
  400 { error: "invalid" }      — unknown party/role/candidate, missing role, duplicate candidate, bad uuid
  403 { error: "captcha" }       — Turnstile verification failed
  403 { error: "forbidden" }     — wrong Content-Type or cross-site Origin
  409 { error: "already_voted" }
  429 { error: "rate_limited" } — > IP_DAILY_LIMIT votes from same IP (HMAC of IP + day; IPv6 counted per /64; never raw IP; not linked to the vote) per UTC day
GET  /api/results?party=<partyId|omitted>
  200 { total, banned, byRole: { roleId: [{ candidateId, pct, count }] } } — top 3 per role, pct 0–100 one decimal; plus ties: [roleId] — roles whose top two counts are equal (UI shows both names)
  During ban window (BAN_START <= now < BAN_END):
    party param → 200 { banned: true } with no data
    no party → counts and total omitted, pct only
GET  /api/status?voterId= → { voted: bool, picks?, partyId? }

## One vote
voterId generated client-side (crypto.randomUUID) and kept in localStorage; server enforces UNIQUE(voter_id) + Cloudflare Turnstile + IP daily limit (200).

## Legal
Permanent disclaimer on results: "זהו אינו סקר מדעי. התוצאות מבוססות על הצבעות גולשים באתר, אינן מבוססות על שיטה סטטיסטית ואין להסיק מהן על דפוסי הצבעה." During ban window: party tabs replaced by "פילוח לפי מפלגות יחזור עם סגירת הקלפיות (27.10, 22:00)".

## Ads
Single reserved ad slot (fixed height) on results screen only, between "הנבחרת שלי" and "נבחרת הרוב". Empty placeholder for now.
