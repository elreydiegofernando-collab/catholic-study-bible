/* Catholic Study Bible service worker (GitHub Pages edition): offline reading
 * of pages already opened.
 *
 * The site lives under a path (/catholic-study-bible/), and so does this
 * worker: BASE is its own folder, and the worker only handles requests there.
 *
 *  - App code, fonts and icons (_next/static, icons, images): cache first. The
 *    file names carry content hashes, so a cached copy is never stale.
 *  - Study data (data/: chapter files, dictionary, search index): network
 *    first, saved copy when offline.
 *  - Pages: network first, falling back to the saved copy when offline or when
 *    the network takes longer than a few seconds. Every page is a static file,
 *    so the query (?v=, &to=, ?t=, ?q=) never changes it: one copy per path.
 *  - Pages reached by in-app navigation arrive as RSC data, not HTML; the page
 *    posts {type: "cache-page"} so the HTML is saved too (sw-register.tsx).
 *    Offline, Next.js falls back to a full page load, which this worker serves.
 *
 * Bump VERSION to drop every saved copy after a breaking change.
 */
const VERSION = "pages-v1";
const BASE = new URL("./", self.location.href).pathname; // "/catholic-study-bible/"
const STATIC_CACHE = `csb-static-${VERSION}`;
const PAGE_CACHE = `csb-pages-${VERSION}`;
const DATA_CACHE = `csb-data-${VERSION}`;
const OFFLINE_URL = `${BASE}offline/`;
const LIMITS = { [STATIC_CACHE]: 300, [PAGE_CACHE]: 400, [DATA_CACHE]: 1500 };
const SLOW_NETWORK_MS = 3500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGE_CACHE)
      .then((c) => c.addAll([new Request(OFFLINE_URL, { cache: "reload" }), new Request(BASE, { cache: "reload" })]))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, PAGE_CACHE, DATA_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith("csb-") && !keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

// One key per page: no query, no hash, and the trailing slash GitHub Pages
// redirects to (/read/JHN/6 -> /read/JHN/6/).
function pageKey(href) {
  const url = new URL(href, self.location.origin);
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/") && !/\.[a-z0-9]+$/i.test(url.pathname)) url.pathname += "/";
  return url.href;
}

async function trim(cacheName) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const extra = keys.length - (LIMITS[cacheName] || 500);
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

async function put(cacheName, key, response) {
  const cache = await caches.open(cacheName);
  await cache.put(key, response);
  await trim(cacheName);
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") put(STATIC_CACHE, request, response.clone());
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") put(DATA_CACHE, request, response.clone());
    return response;
  } catch (err) {
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;
    return new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
}

async function page(event) {
  const key = pageKey(event.request.url);
  const cache = await caches.open(PAGE_CACHE);
  const network = fetch(event.request).then((response) => {
    if (response.ok && response.type === "basic" && !response.redirected) {
      event.waitUntil(put(PAGE_CACHE, key, response.clone()));
    }
    return response;
  });
  const cached = await cache.match(key);
  if (!cached) {
    return network.catch(async () => (await cache.match(OFFLINE_URL)) || offline());
  }
  // A saved copy exists: prefer the fresh page, but do not keep the reader
  // waiting on a weak connection. The network result still refreshes the copy.
  event.waitUntil(network.catch(() => {}));
  return Promise.race([
    network.catch(() => cached),
    new Promise((resolve) => setTimeout(() => resolve(cached), SLOW_NETWORK_MS)),
  ]);
}

function offline() {
  return new Response("<h1>Offline</h1><p>This page has not been saved on this device.</p>", {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE) || url.pathname === `${BASE}sw.js`) return;
  const path = url.pathname.slice(BASE.length - 1); // "/_next/static/…", "/data/…", "/read/…"

  if (path.startsWith("/_next/static/") || path.startsWith("/icons/") || /\.(?:woff2?|ico|png|svg)$/.test(path)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (path.startsWith("/data/")) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(page(event));
  }
  // Everything else (RSC payloads, prefetches): straight to the network.
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "cache-page" || typeof data.url !== "string") return;
  const url = new URL(data.url, self.location.origin);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  event.waitUntil(
    (async () => {
      const key = pageKey(url.href);
      const cache = await caches.open(PAGE_CACHE);
      if (await cache.match(key)) return;
      try {
        const response = await fetch(key, { credentials: "same-origin" });
        const type = response.headers.get("content-type") || "";
        if (response.ok && !response.redirected && type.includes("text/html")) await put(PAGE_CACHE, key, response);
      } catch (err) {
        /* offline: nothing to save */
      }
    })(),
  );
});
