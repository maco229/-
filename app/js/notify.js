// Reminder notifications
import { kvGet, kvSet } from './db.js';
import { today } from './srs.js';

export function notifSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator;
}

export async function requestPermission() {
  if (!notifSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

export async function showReminder(dueCount) {
  if (!notifSupported() || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  const body = dueCount > 0
    ? `今日の復習が ${dueCount} 枚あります。サクッと片付けましょう！`
    : '今日の復習は完了しています。新しいカードを追加しませんか？';
  await reg.showNotification('暗記ノート：復習の時間です', {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'daily-reminder',
    data: { url: './#/' },
  });
  await kvSet('lastNotified', today());
  return true;
}

let timer;
// While the app is running, fire the reminder at the configured time.
export function scheduleInApp(settings, getDueCount) {
  clearTimeout(timer);
  if (!settings.reminderOn) return;
  const [h, m] = settings.reminderTime.split(':').map(Number);
  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  const ms = Math.min(at - now, 2 ** 31 - 1);
  timer = setTimeout(async () => {
    const last = await kvGet('lastNotified', '');
    if (last !== today()) await showReminder(await getDueCount());
    scheduleInApp(settings, getDueCount);
  }, ms);
}

// Android Chrome (installed PWA): ask the OS to wake the SW about once a day.
export async function registerPeriodicSync(on) {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return false;
    if (!on) { await reg.periodicSync.unregister('daily-reminder'); return false; }
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state !== 'granted') return false;
    await reg.periodicSync.register('daily-reminder', { minInterval: 6 * 60 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}

// Calendar file with a daily recurring event + alarm (the most reliable reminder)
export function buildICS(time, appUrl) {
  const [h, m] = time.split(':');
  const d = today().replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//shindanshi-anki//JP',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:daily-reminder-${Date.now()}@shindanshi-anki`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${d}T${h}${m}00`,
    'DURATION:PT15M',
    'RRULE:FREQ=DAILY',
    'SUMMARY:暗記ノート 今日の復習',
    `DESCRIPTION:診断士の暗記カードを復習しましょう。 ${appUrl}`,
    `URL:${appUrl}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:暗記ノート 復習の時間です',
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
}
