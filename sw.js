/**
 * Service worker for the Checkpoint Verification PWA.
 *
 * Strategy:
 *  - The app HTML itself: network-first, falling back to cache. Officers
 *    online get the latest version; offline, the last-loaded version still
 *    opens instead of a browser error page.
 *  - This same-origin app shell (manifest, icons): cache-first — these
 *    never change without a redeploy, so there's no need to hit the network.
 *  - Third-party assets (Tesseract.js, Google Fonts): stale-while-revalidate
 *    — serve instantly from cache if we have it, and quietly refresh the
 *    cache in the background for next time.
 *  - Calls to the Apps Script API (/exec): always network, never cached.
 *    Checkpoint data changes constantly, so a cached response would be
 *    actively unsafe here (e.g. showing a cleared vehicle as flagged, or
 *    vice versa). If offline, this correctly fails and the app's existing
 *    "check your connection" messaging kicks in.
 *
 * Bump CACHE_VERSION whenever the app shell changes so old, stale caches on
 * officers' phones get cleared out automatically.
 */
const CACHE_VERSION = 'checkpoint-v1';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

// Files that make up the installable app shell. Update this list if you
// rename the HTML file or add more same-origin assets.
const SHELL_FILES = [
  './',
  './Checkpoint_Vehicle_Verifier.html',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('checkpoint-') && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function isApiCall(url) {
  // Apps Script web app endpoints — never cache these.
  return url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com';
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  const cache = await caches.open(SHELL_CACHE);
  cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((fresh) => { cache.put(request, fresh.clone()); return fresh; })
    .catch(() => cached); // offline and nothing new — fall back silently
  return cached || networkPromise;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POSTs (all API writes)

  const url = new URL(req.url);

  if (isApiCall(url)) {
    return; // let it hit the network untouched — no caching, no fallback
  }

  if (isSameOrigin(url) && req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  if (isSameOrigin(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Cross-origin static assets (Tesseract.js CDN, Google Fonts, etc.)
  event.respondWith(staleWhileRevalidate(req));
});
