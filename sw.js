// Network first, so updates arrive as soon as they're published; falls back to the last cached copy
// when the tablet is offline. The speech model is cached separately by the app.
const CACHE = 'vo-prompter-v2';
const CORE = ['./', 'index.html', 'js/app.js', 'js/parse.js', 'js/zip.js', 'js/follow.js', 'js/engines.js', 'js/store.js', 'js/tts.js', 'js/piper.js', 'js/vo.js',
  'capture-worklet.js', 'vendor/vosk.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'fonts/jetbrains-mono-latin-400-normal.woff2', 'fonts/jetbrains-mono-latin-600-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => /^vo-prompter-v\d+$/.test(k) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/models/')) return;
  e.respondWith(fetch(new Request(req, { cache: 'no-cache' })).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
