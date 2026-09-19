/* Tri3M service worker — Web Push (VAPID) device notifications.
   Registered only from the app origin; no caching, no fetch interception. */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'New notification', body: '', url: '/', tag: 'tri3m' };
  try { data = { ...data, ...event.data.json() }; } catch (e) { /* legacy plain text */ }
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // App already open in foreground → in-app badge updates handle it; skip
    // the screen notification to avoid double-notify.
    const visible = clientList.some((c) => c.visibilityState === 'visible');
    if (visible) return;
    await self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: `${self.location.origin}/logo-192.png`,
      badge: `${self.location.origin}/logo-64.png`,
      data: { url: data.url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if (client.url === url && 'focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
