const CACHE = 'agency-invoicer-v1';
const APP_FILES = ['/', 'index.html', 'styles/main.css', 'styles/print.css', 'js/config.js', 'js/app.js', 'assets/invoice-wave.png', 'assets/icon.svg'];

self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
