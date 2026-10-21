const MARKS = /[֑-ׇֽֿׁׂׅׄ]/g;
const QUOTES = /["'`׳״‘’“”]/g;
const SEPARATORS = /[\s־\-–—.,()]+/;

export function normalize(s) {
  return String(s).normalize('NFD').replace(MARKS, '').replace(/[\u0300-\u036f]/g, '').replace(QUOTES, '').replace(/וו/g, 'ו').toLowerCase().trim();
}

export function words(s) {
  return normalize(s).split(SEPARATORS).filter(Boolean);
}

export function matches(nameWords, query) {
  const q = words(query);
  if (!q.length) return true;
  const used = new Set();
  return q.every((qw) => {
    const i = nameWords.findIndex((w, idx) => !used.has(idx) && w.startsWith(qw));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}
