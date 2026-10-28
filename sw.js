// Network first, so updates arrive as soon as they're published; falls back to the last cached copy
// when the tablet is offline. The speech model is cached separately by the app.
const CACHE = 'vo-prompter-v2';
const CORE = ['./', 'index.html', 'js/app.js', 'js/parse.js', 'js/zip.js', 'js/follow.js', 'js/engines.js', 'js/store.js', 'js/tts.js', 'js/piper.js', 'js/vo.js', 'js/mp4info.js',
  'capture-worklet.js', 'vendor/vosk.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'fonts/jetbrains-mono-latin-400-normal.woff2', 'fonts/jetbrains-mono-latin-600-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => /^vo-prompter-v\d+$/.test(k) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// The script's video, served like a normal website video (with byte ranges) straight from the app's storage.
// Some browsers (Edge on Android) stall playing a stored video through a blob: link but play this fine.
function storedVideo(id) {
  return new Promise((resolve) => {
    const r = indexedDB.open('vo-prompter');
    r.onsuccess = () => {
      const d = r.result;
      try {
        const q = d.transaction('videos').objectStore('videos').get(id);
        q.onsuccess = () => { d.close(); resolve(q.result || null); };
        q.onerror = () => { d.close(); resolve(null); };
      } catch (e) { d.close(); resolve(null); }
    };
    r.onerror = () => resolve(null);
  });
}
async function localVideo(req, id) {
  const rec = await storedVideo(id);
  if (!rec || !rec.blob) return new Response('', { status: 404 });
  const blob = rec.blob, size = blob.size, type = rec.type || 'video/mp4';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) return new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - +m[2]); end = size - 1; } else { start = +m[1]; end = m[2] === '' ? size - 1 : +m[2]; }
  if (start >= size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  end = Math.min(end, size - 1, start + 8 * 1024 * 1024 - 1); // answer in pieces of up to 8 MB
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const vi = req.url.indexOf('/local-video/');
  if (req.method === 'GET' && vi >= 0 && new URL(req.url).origin === self.location.origin) {
    e.respondWith(localVideo(req, decodeURIComponent(req.url.slice(vi + 13).split('?')[0])));
    return;
  }
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/models/')) return;
  e.respondWith(fetch(new Request(req, { cache: 'no-cache' })).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
