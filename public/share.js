const W = 1080;
const H = 1350;
const FONT = "Rubik, system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
const C = { stone: '#efe5cf', stone2: '#e6d9bc', navy: '#13284f', gold: '#b48a2c', goldText: '#f3dc9b', wood: '#6e5024', sub: '#5c4a22' };

async function fontsReady() {
  try {
    await Promise.all(['400', '500', '700'].map((w) => document.fonts.load(`${w} 32px Rubik`)));
    await document.fonts.ready;
  } catch { /* fall back to system font */ }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function font(ctx, weight, size) {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trim()}…`;
}

function wrap(ctx, words, maxW) {
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function fitName(ctx, name, maxW, sizes, weight, maxLines) {
  const words = name.trim().split(/\s+/);
  for (const size of sizes) {
    font(ctx, weight, size);
    const lines = wrap(ctx, words, maxW);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) return { size, lines };
  }
  const size = sizes.at(-1);
  font(ctx, weight, size);
  const lines = wrap(ctx, words, maxW);
  const first = ellipsize(ctx, lines[0], maxW);
  if (maxLines === 1) return { size, lines: [ellipsize(ctx, lines.join(' '), maxW)] };
  return { size, lines: lines.length > 1 ? [first, ellipsize(ctx, lines.slice(1).join(' '), maxW)] : [first] };
}

function drawName(ctx, name, cx, y, maxW, sizes, weight, maxLines = 2) {
  const { size, lines } = fitName(ctx, name, maxW, sizes, weight, maxLines);
  font(ctx, weight, size);
  ctx.fillStyle = C.navy;
  lines.forEach((l, i) => ctx.fillText(l, cx, y + i * Math.round(size * 1.18)));
}

function pill(ctx, text, cx, cy, { bg, fg, size = 22, weight = 500 }) {
  font(ctx, weight, size);
  const w = ctx.measureText(text).width + 28;
  const h = size + 14;
  ctx.fillStyle = bg;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 1);
  ctx.textBaseline = 'alphabetic';
}

function avatar(ctx, cand, cx, cy, r, h) {
  const color = h.partyColor(cand) || '#6b7280';
  ctx.save();
  ctx.shadowColor = 'rgba(40, 30, 10, .3)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, r + 9, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  font(ctx, 700, Math.round(r * 0.72));
  ctx.fillStyle = h.textOn(color);
  ctx.textBaseline = 'middle';
  ctx.fillText(h.initials(h.name(cand)), cx, cy + 2);
  ctx.textBaseline = 'alphabetic';
}

function background(ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, C.stone);
  g.addColorStop(1, C.stone2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(120, 95, 50, .08)';
  ctx.lineWidth = 2;
  for (let y = 54; y < H; y += 54) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  for (let x = 0; x < W; x += 108) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  const glow = ctx.createRadialGradient(W / 2, 0, 50, W / 2, 0, 800);
  glow.addColorStop(0, 'rgba(255, 255, 255, .6)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(180, 138, 44, .3)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(W / 2, 1180, 760, Math.PI, 0); ctx.stroke();
  ctx.strokeStyle = 'rgba(180, 138, 44, .55)';
  ctx.lineWidth = 3;
  roundRect(ctx, 24, 24, W - 48, H - 48, 28); ctx.stroke();
  ctx.strokeStyle = 'rgba(19, 40, 79, .25)';
  ctx.lineWidth = 2;
  roundRect(ctx, 36, 36, W - 72, H - 72, 20); ctx.stroke();
}

function bench(ctx, xRight, xLeft, y, sag) {
  const mid = (xRight + xLeft) / 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = C.wood;
  ctx.lineWidth = 16;
  ctx.beginPath(); ctx.moveTo(xRight, y); ctx.quadraticCurveTo(mid, y + sag * 2, xLeft, y); ctx.stroke();
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(xRight, y - 8); ctx.quadraticCurveTo(mid, y - 8 + sag * 2, xLeft, y - 8); ctx.stroke();
}

export async function renderShareImage({ picks, rows, labels, texts, dir, host, helpers }) {
  await fontsReady();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.direction = dir;
  ctx.textAlign = 'center';
  background(ctx);

  font(ctx, 700, 64);
  ctx.fillStyle = C.navy;
  ctx.fillText(texts.title, W / 2, 122);
  font(ctx, 500, 32);
  ctx.fillStyle = C.sub;
  ctx.fillText(texts.date, W / 2, 174);

  const cand = (id) => helpers.cand(picks[id]);

  const pm = cand('pm');
  pill(ctx, labels.pm, W / 2, 222, { bg: C.gold, fg: '#1d1300', size: 24 });
  ctx.fillStyle = C.navy;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 150, 372); ctx.lineTo(W / 2 + 150, 372); ctx.lineTo(W / 2 + 180, 424); ctx.lineTo(W / 2 - 180, 424);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = C.gold;
  ctx.fillRect(W / 2 - 150, 368, 300, 6);
  font(ctx, 700, 22);
  ctx.fillStyle = C.goldText;
  ctx.fillText(texts.table, W / 2, 412);
  if (pm) avatar(ctx, pm, W / 2, 322, 62, helpers);
  if (pm) drawName(ctx, helpers.name(pm), W / 2, 470, 600, [40, 36, 32, 28], 700, 1);

  const spans = [14, 15, 16];
  const base = 590;
  rows.slice(1).forEach((row, ri) => {
    const rowW = 960 * (spans[ri] / 16);
    const seatW = rowW / 4;
    const xRight = W / 2 + rowW / 2;
    const cy = base + ri * 246;
    bench(ctx, xRight - 18, xRight - rowW + 18, cy + 34, 18);
    row.forEach((id, p) => {
      const c = cand(id);
      const cx = dir === 'rtl' ? xRight - seatW * (p + 0.5) : xRight - rowW + seatW * (p + 0.5);
      const y = cy + (p === 1 || p === 2 ? 18 : 0);
      pill(ctx, labels[id] || id, cx, y - 80, { bg: C.navy, fg: '#fff' });
      if (!c) return;
      avatar(ctx, c, cx, y, 48, helpers);
      drawName(ctx, helpers.name(c), cx, y + 88, seatW - 18, [30, 28, 26, 24, 22], 500);
    });
  });

  ctx.strokeStyle = 'rgba(180, 138, 44, .7)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2 - 220, 1252); ctx.lineTo(W / 2 + 220, 1252); ctx.stroke();
  font(ctx, 500, 30);
  ctx.fillStyle = C.navy;
  ctx.fillText(host, W / 2, 1298);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
}
