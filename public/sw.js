const CACHE = "whisperflow-v20";
const SHELL = [
  "/",
  "/style.css",
  "/manifest.webmanifest",
  "/js/app.js",
  "/js/store.js",
  "/js/api.js",
  "/js/session.js",
  "/js/recorder.js",
  "/js/pcm-worklet.js",
  "/js/vad.js",
  "/js/audio-utils.js",
  "/js/waveform.js",
  "/icons/icon-192.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first: fresh files when online, cached copy when offline.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") return caches.match("/");
        return Response.error();
      })
  );
});
