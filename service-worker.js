// BİMKOD Service Worker
// HIZ stratejisi:
//  - Kurulumda sadece küçük uygulama kabuğu önbelleğe alınır (eskiden 32 MB'lık
//    embeddings.bin dahil hepsi iniyordu; ayrıca var olmayan bir dosya yüzünden
//    addAll() hata verip kurulum hiç tamamlanmıyordu).
//  - HTML/JS/CSS ve products.json: önce ağ (güncel kalsın), yavaşsa kısa zaman
//    aşımından sonra önbellek -> yavaş bağlantıda site yine hızlı açılır.
//  - embeddings.bin: önbellek-öncelikli (URL'deki ?c=sayı değişince yenisi iner).
//  - images/: önbellekten hemen göster, arkada güncelle (stale-while-revalidate).
const CACHE_NAME = "bimkod-v5";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/logoheader.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // tek bir dosya hata verse bile kurulum bozulmasın
      Promise.all(CORE_ASSETS.map((u) => cache.add(u).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function networkFirst(request, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const fromCache = () => caches.match(request).then((hit) => hit || null);
    const timer = timeoutMs
      ? setTimeout(async () => {
          const hit = await fromCache();
          if (hit && !settled) { settled = true; resolve(hit); }
        }, timeoutMs)
      : null;

    fetch(request)
      .then((response) => {
        clearTimeout(timer);
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
        }
        if (!settled) { settled = true; resolve(response); }
      })
      .catch(async () => {
        clearTimeout(timer);
        const hit = await fromCache();
        if (!settled) { settled = true; resolve(hit || Response.error()); }
      });
  });
}

async function cacheFirstBin(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response && response.status === 200) {
    // eski sürüm .bin kopyalarını sil (her biri ~32 MB)
    for (const k of await cache.keys()) {
      if (new URL(k.url).pathname.endsWith("/data/embeddings.bin")) await cache.delete(k);
    }
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((r) => { if (r && r.status === 200) cache.put(request, r.clone()); return r; })
    .catch(() => null);
  return hit || (await refresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // CDN/Firebase/AdSense'e dokunma

  if (url.pathname.endsWith("/data/embeddings.bin")) {
    event.respondWith(cacheFirstBin(req));
  } else if (url.pathname.includes("/images/")) {
    event.respondWith(staleWhileRevalidate(req));
  } else if (url.pathname.endsWith("/data/products.json") || url.pathname.endsWith("/data/embeddings.json")) {
    event.respondWith(networkFirst(req, 4000));
  } else {
    event.respondWith(networkFirst(req, 0));
  }
});
