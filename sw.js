/* Service worker: keeps the app working with no signal (a campus lawn is a
   surprisingly bad place for reception).

   Strategy: network-first for everything, falling back to the cache when the
   network is slow or absent. Cache-first would open a touch faster, but it
   serves the previous visit's page — so an update you pushed this morning
   wouldn't show up until someone opened the app twice. Being right matters
   more here than saving 50ms on a 60KB page. */

const VERSION = "rueda-v6";
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

  // Leave third parties alone (YouTube, Google Calendar, Open-Meteo).
  if (new URL(req.url).origin !== location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () =>
        (await caches.match(req, { ignoreSearch: true })) ||
        (req.mode === "navigate" ? caches.match("index.html") : Response.error())
      )
  );
});
