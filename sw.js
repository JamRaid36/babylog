// Keeps the app opening with no signal. Network first, so a new version shows up on the next open;
// every request asks the server whether its copy is still current ('no-cache'), because the host lets a
// browser reuse a file for 10 minutes and a phone was seen showing the old app after a new one shipped.
// the saved copy is only used when the network fails. Requests to GitHub's API are never touched.
const CACHE = 'babylog-v20';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'meds.js', 'sync.js', 'manifest.webmanifest', 'bloom-180.png', 'bloom-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
