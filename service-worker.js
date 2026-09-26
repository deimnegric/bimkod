// BİMKOD Service Worker
// Amaç: uygulamanın offline'da da açılabilmesi.
//
// STRATEJİ: network-first (önce ağdan dene, offline'sa cache'e düş).
// Önceki "cache-first" stratejisi, dosyalar her güncellendiğinde tarayıcının
// SONSUZA KADAR eski sürümü göstermesine sebep oluyordu (hard refresh bile
// bunu aşamıyordu) -- aktif geliştirme sürecinde bu ciddi kafa karışıklığına
// yol açtı. network-first ile her zaman en güncel dosya gösterilir, sadece
// internet yokken cache devreye girer.

const CACHE_NAME = "bimkod-v2";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./data/products.json",
  "./data/embeddings.json",
  "./data/embeddings.bin",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
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

// Network-first: önce ağdan çek (ve cache'i güncelle), ağ başarısız olursa
// (offline) cache'e düş. Böylece dosyalar güncellendiğinde kullanıcı hep
// en güncelini görür, sadece internetsizken eski (cache'li) sürüm devreye girer.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
