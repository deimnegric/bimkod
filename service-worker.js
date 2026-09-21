// BİMKOD Service Worker
// Amaç: statik dosyaları (ve ileride embeddings.bin / products.json) cache'leyip
// uygulamanın her açılışta anında (offline dahil) yüklenmesini sağlamak.

const CACHE_NAME = "bimkod-v1";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  // Gerçek sistemde eklenecek:
  "./data/products.json",
  "./data/embeddings.json",
  "./data/embeddings.bin",
  // "./models/yolo.onnx",
  // "./models/clip-vision.onnx",
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

// Cache-first: önce cache'e bak, yoksa ağdan çek ve cache'e ekle.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
