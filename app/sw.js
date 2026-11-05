// Service Worker: offline cache + daily reminder
const VERSION = 'v1.0.0';
const CACHE = 'anki-' + VERSION;
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/srs.js',
  'js/util.js',
  'js/notify.js',
  'js/backup.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/katex/katex.min.js',
  'vendor/katex/katex.min.css',
  'vendor/katex/contrib/auto-render.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // network first, fall back to cache (offline)
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req, { ignoreSearch: true })) || caches.match('index.html');
      }
    })());
  }
});

// ---------- reminder (periodic background sync, Android Chrome) ----------
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('shindanshi-anki');
    r.onupgradeneeded = () => r.transaction.abort(); // never create the DB from here
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const pad = (n) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function maybeRemind() {
  const db = await idb();
  const kv = db.transaction('kv').objectStore('kv');
  const settings = (await reqP(kv.get('settings'))) || {};
  if (!settings.reminderOn) return;
  const [h, m] = (settings.reminderTime || '20:00').split(':').map(Number);
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  const t = today(now);
  if ((await reqP(db.transaction('kv').objectStore('kv').get('lastNotified'))) === t) return;
  const cards = await reqP(db.transaction('cards').objectStore('cards').getAll());
  const newToday = (await reqP(db.transaction('kv').objectStore('kv').get('newToday'))) || {};
  const used = newToday.date === t ? newToday.count : 0;
  const limit = Math.max(0, (settings.newPerDay ?? 30) - used);
  let due = 0, nw = 0;
  for (const c of cards) {
    if (c.state === 'new') nw++;
    else if (c.state !== 'mastered' && c.due <= t) due++;
  }
  const n = due + Math.min(nw, limit);
  await self.registration.showNotification('暗記ノート：復習の時間です', {
    body: n > 0 ? `今日の復習が ${n} 枚あります。サクッと片付けましょう！` : '今日の復習は完了しています。新しいカードを追加しませんか？',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'daily-reminder',
    data: { url: './#/' },
  });
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(t, 'lastNotified');
}

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'daily-reminder') e.waitUntil(maybeRemind().catch(() => {}));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.navigate?.('./#/'); return c.focus(); }
    }
    return self.clients.openWindow(e.notification.data?.url || './');
  })());
});
