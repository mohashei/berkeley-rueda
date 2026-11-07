/* Service worker: makes the app open instantly and keep working with no signal
   (a campus lawn is a surprisingly bad place for reception).
   Shell files are cached on install; data files are fetched fresh when possible
   and served from cache when not. */

const VERSION = "rueda-v2";
const SHELL = [
  ".", "index.html", "app.css", "app.js",
  "manifest.webmanifest", "icons/favicon.svg", "icons/apple-touch-icon.png",
  "icons/icon-192.png", "icons/icon-512.png",
  "data/config.json", "data/moves.json", "data/events.json", "data/status.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache third parties (YouTube, Google Calendar, Open-Meteo).
  if (url.origin !== location.origin) return;

  const isData = url.pathname.includes("/data/");

  if (isData) {
    // network-first: today's events beat yesterday's events
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // cache-first for the shell, with a background refresh
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit || caches.match("index.html"));
      return hit || net;
    })
  );
});
