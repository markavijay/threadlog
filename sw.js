/**
 * ThreadLog Service Worker
 * Strategy: Cache-first for app shell, network-first for data/API calls
 */

const CACHE_NAME = 'threadlog-v1';
const DATA_CACHE_NAME = 'threadlog-data-v1';

// App shell files — cached on install, served from cache always
const APP_SHELL = [
  '/index.html',
  '/css/main.css',
  '/js/db.js',
  '/js/contacts.js',
  '/js/timeline.js',
  '/js/reminders.js',
  '/js/sync.js',
  '/js/app.js',
  '/manifest.json',
  // Tabler Icons CDN — cached on first fetch
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css',
];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing ThreadLog service worker…');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching app shell');
        // Cache what we can; don't fail install if CDN is unreachable
        return Promise.allSettled(
          APP_SHELL.map(url =>
            cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys().then(keyList =>
      Promise.all(
        keyList
          .filter(key => key !== CACHE_NAME && key !== DATA_CACHE_NAME)
          .map(key => {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Google APIs — network only, no caching
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('accounts.google.com')) {
    event.respondWith(fetch(request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // App shell — cache first, fall back to network
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
        return response;
      }).catch(() => {
        // Offline fallback — return index.html for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});

// ─── Push Notifications (reminders) ──────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'ThreadLog Reminder', {
      body: data.body || '',
      tag: data.tag || 'threadlog-reminder',
      data: { contactId: data.contactId, reminderId: data.reminderId },
      actions: [
        { action: 'view', title: 'Open contact' },
        { action: 'dismiss', title: 'Dismiss' }
      ],
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const { contactId } = event.notification.data || {};
  const targetUrl = contactId ? `/index.html?contact=${contactId}` : '/index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('threadlog') && 'focus' in client) {
          client.postMessage({ type: 'OPEN_CONTACT', contactId });
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// ─── Background sync (reminder checks) ───────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-reminders') {
    event.waitUntil(checkDueReminders());
  }
});

async function checkDueReminders() {
  // Notify the main thread to check reminders
  const clientList = await clients.matchAll({ type: 'window' });
  clientList.forEach(client => client.postMessage({ type: 'CHECK_REMINDERS' }));
}
