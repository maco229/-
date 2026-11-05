// Spaced repetition scheduling
export const DEFAULT_SETTINGS = {
  schedule: [1, 3, 7, 14, 30, 60], // days for each level
  hardDays: 1,
  newPerDay: 30,
  againGap: 3, // re-show "again" cards after N other cards
  shuffle: true,
  math: true,
  reminderOn: false,
  reminderTime: '20:00',
};

const pad = (n) => String(n).padStart(2, '0');

export function today(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return today(new Date(y, m - 1, d + n));
}

export function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((new Date(pb[0], pb[1] - 1, pb[2]) - new Date(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

export function isDue(card, t = today()) {
  return card.state !== 'mastered' && card.due <= t;
}

export function newCardFields() {
  return { state: 'new', level: 0, due: today(), reviews: 0, correct: 0, lapses: 0, lastGrade: null, lastReviewed: null };
}

export function dayLabel(n) {
  if (n <= 0) return '今日';
  if (n === 1) return '明日';
  return `${n}日後`;
}

// Returns {state, level, due, label} without mutating card
export function preview(card, grade, settings) {
  const S = settings.schedule.length ? settings.schedule : DEFAULT_SETTINGS.schedule;
  const t = today();
  const lv = card.state === 'mastered' ? S.length : (card.level || 0);
  if (grade === 'again') return { state: 'learning', level: 0, due: t, label: '今日もう一度' };
  if (grade === 'hard') {
    const d = Math.max(1, settings.hardDays | 0);
    return { state: 'learning', level: Math.min(lv, S.length - 1), due: addDays(t, d), label: dayLabel(d) };
  }
  const nl = Math.min(lv, S.length) + (grade === 'easy' ? 2 : 1);
  if (nl > S.length) return { state: 'mastered', level: S.length + 1, due: addDays(t, 36500), label: 'クリア' };
  const d = S[nl - 1];
  return { state: 'review', level: nl, due: addDays(t, d), label: dayLabel(d) };
}

export function applyGrade(card, grade, settings) {
  const p = preview(card, grade, settings);
  return {
    ...card,
    state: p.state,
    level: p.level,
    due: p.due,
    reviews: (card.reviews || 0) + 1,
    correct: (card.correct || 0) + (grade === 'good' || grade === 'easy' ? 1 : 0),
    lapses: (card.lapses || 0) + (grade === 'again' ? 1 : 0),
    lastGrade: grade,
    lastReviewed: Date.now(),
  };
}

export function statusText(card) {
  const t = today();
  switch (card.state) {
    case 'new': return { text: '未学習', cls: 'st-new' };
    case 'mastered': return { text: 'クリア', cls: 'st-done' };
    default: {
      if (card.due <= t) return { text: '今日復習', cls: 'st-due' };
      return { text: dayLabel(daysBetween(t, card.due)), cls: 'st-later' };
    }
  }
}

export function parseSchedule(str) {
  const arr = String(str).split(/[,\s、，]+/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
  return arr.length ? arr : null;
}
