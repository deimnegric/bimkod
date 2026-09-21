// ============================================================
// BİMKOD — Gerçek arama motoru
//   - Metin arama : Fuse.js (data/products.json üzerinde, Türkçe normalize)
//   - Görsel arama: Transformers.js (CLIP, tarayıcıda, ONNX/WASM) + cosine similarity
//                   data/embeddings.json içindeki 30k+ vektörle karşılaştırılır
// Coldstart yok: her şey statik dosya (GitHub Pages). CLIP modeli ilk açılışta
// indirilir, sonra tarayıcı cache'i (+service worker) sayesinde anında yüklenir.
// ============================================================

import { pipeline, cos_sim } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0";

const PAGE_SIZE = 10;
const DATA_VERSION_KEY = "bimkod_data_version";

const state = {
  query: "",
  mode: "text",       // "text" | "visual"
  visualThumb: null,
  page: 1,
  results: [],
};

let PRODUCTS = [];        // data/products.json -> [{code, name, cat, image, embIndex}]
let EMBEDDINGS = null;    // Float32Array[] aligned with PRODUCTS by embIndex
let fuse = null;
let clipExtractor = null; // transformers.js pipeline, lazy-loaded on first visual search

// ---------- DOM ----------
const el = {
  searchInput: document.getElementById("searchInput"),
  clearSearch: document.getElementById("clearSearch"),
  btnCamera: document.getElementById("btnCamera"),
  btnUpload: document.getElementById("btnUpload"),
  cameraInput: document.getElementById("cameraInput"),
  uploadInput: document.getElementById("uploadInput"),
  visualBanner: document.getElementById("visualQueryBanner"),
  visualThumb: document.getElementById("visualQueryThumb"),
  clearVisualQuery: document.getElementById("clearVisualQuery"),
  resultsInfo: document.getElementById("resultsInfo"),
  resultsList: document.getElementById("resultsList"),
  pagination: document.getElementById("pagination"),
  emptyState: document.getElementById("emptyState"),
  imageModal: document.getElementById("imageModal"),
  imageModalImg: document.getElementById("imageModalImg"),
  toast: document.getElementById("toast"),
  statusBar: document.getElementById("statusBar"),
  newArrivals: document.getElementById("newArrivals"),
  newArrivalsList: document.getElementById("newArrivalsList"),
};

const NEW_BADGE_HOURS = 72; // bu süreden yeni ise "YENİ" rozeti gösterilir

function isRecentlyAdded(product) {
  if (!product.addedAt) return false;
  const hours = (Date.now() - new Date(product.addedAt).getTime()) / 36e5;
  return hours <= NEW_BADGE_HOURS;
}

function renderNewArrivals() {
  const hasQuery = state.mode === "text" ? state.query.trim().length > 0 : true;
  if (hasQuery) { el.newArrivals.hidden = true; return; }

  const recent = [...PRODUCTS]
    .filter((p) => p.addedAt)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
    .slice(0, 20);

  if (recent.length === 0) { el.newArrivals.hidden = true; return; }

  el.newArrivals.hidden = false;
  el.newArrivalsList.innerHTML = recent.map((p) => `
    <div class="new-arrival-card" data-code="${p.code}">
      <span class="badge-new">YENİ</span>
      <div class="thumb">${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy">` : ""}</div>
      <div class="name">${p.name}</div>
    </div>
  `).join("");

  [...el.newArrivalsList.children].forEach((card, i) => {
    card._product = recent[i];
  });
}

// ---------- Türkçe normalize ----------
function trNormalize(str) {
  return str
    .replace(/İ/g, "i").replace(/I/g, "ı")
    .toLowerCase()
    .replace(/ş/g, "s").replace(/ç/g, "c").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ı/g, "i")
    .trim();
}

// ---------- Veri yükleme (products.json + embeddings.bin) ----------
// Embedding'ler artık ham binary (float32) dosyada -> JSON parse yok,
// tek büyük ArrayBuffer fetch'i + üzerine "bakan" Float32Array view'ları.
// Eski JSON-vektör formatına göre ~5.5 kat daha az veri indirilir.
async function loadData() {
  showStatus("Ürün verisi yükleniyor…");
  const [productsRes, embMeta, embBuf] = await Promise.all([
    fetch("data/products.json").then((r) => r.json()).catch(() => []),
    fetch("data/embeddings.json").then((r) => r.json()).catch(() => null),
    fetch("data/embeddings.bin").then((r) => r.arrayBuffer()).catch(() => null),
  ]);

  PRODUCTS = productsRes.map((p) => ({ ...p, normName: trNormalize(p.name) }));

  if (embMeta && embBuf) {
    const dim = embMeta.dim;
    const bytesPerVec = dim * 4; // float32 = 4 byte
    EMBEDDINGS = [];
    for (let i = 0; i < embMeta.count; i++) {
      EMBEDDINGS.push(new Float32Array(embBuf, i * bytesPerVec, dim));
    }
  }

  fuse = new Fuse(PRODUCTS, {
    keys: ["normName"],
    threshold: 0.35,
    ignoreLocation: true,
  });

  hideStatus();
}

// ---------- Metin arama (Fuse.js fuzzy search) ----------
function runTextSearch(query) {
  const q = trNormalize(query);
  if (!q) return [];
  return fuse.search(q).map((r) => ({ ...r.item, score: 1 - r.score }));
}

// ---------- Görsel arama (CLIP embedding + cosine similarity) ----------
async function runVisualSearch(imageDataUrl) {
  if (!clipExtractor) {
    showStatus("Görsel arama motoru ilk kez hazırlanıyor (~30sn)…");
    // Xenova/clip-vit-base-patch32: quantized ONNX, tarayıcıda WASM ile çalışır
    clipExtractor = await pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32", {
      quantized: true,
    });
  }
  showStatus("Görsel analiz ediliyor…");

  const output = await clipExtractor(imageDataUrl, { pooling: "mean", normalize: true });
  const queryVec = Float32Array.from(output.data);

  hideStatus();

  if (!EMBEDDINGS || EMBEDDINGS.length === 0) {
    return [];
  }

  const scored = PRODUCTS.map((p, i) => {
    const vec = EMBEDDINGS[p.embIndex ?? i];
    if (!vec) return null;
    return { ...p, score: cos_sim(queryVec, vec) };
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 100); // en benzer ilk 100 ürün
}

// ---------- Status bar ----------
function showStatus(msg) {
  el.statusBar.hidden = false;
  el.statusBar.textContent = msg;
}
function hideStatus() {
  el.statusBar.hidden = true;
}

// ---------- Render ----------
function highlightMatch(name, query) {
  if (!query) return name;
  const normName = trNormalize(name);
  const normQuery = trNormalize(query);
  const idx = normName.indexOf(normQuery);
  if (idx === -1) return name;
  return (
    name.slice(0, idx) +
    "<mark>" + name.slice(idx, idx + query.length) + "</mark>" +
    name.slice(idx + query.length)
  );
}

function render() {
  const hasQuery = state.mode === "text" ? state.query.trim().length > 0 : true;
  const isVisual = state.mode === "visual";
  const isDefaultBrowse = !hasQuery; // arama kutusu boş -> varsayılan listeleme modu

  renderNewArrivals();

  el.visualBanner.hidden = !isVisual;
  if (isVisual && state.visualThumb) el.visualThumb.src = state.visualThumb;

  if (isDefaultBrowse) {
    if (PRODUCTS.length === 0) {
      el.emptyState.hidden = false;
      el.resultsList.innerHTML = "";
      el.resultsInfo.textContent = "";
      el.pagination.hidden = true;
      return;
    }
    // Henüz "en çok aranan" takibi yok -> varsayılan olarak en yeni eklenenden eskiye sırala
    state.results = [...PRODUCTS].sort(
      (a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0)
    );
  }
  el.emptyState.hidden = true;

  const total = state.results.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageItems = state.results.slice(start, start + PAGE_SIZE);

  el.resultsInfo.textContent = isDefaultBrowse
    ? `Tüm ürünler (${total})`
    : total
      ? `${total} ürün bulundu`
      : (isVisual ? "Benzer ürün bulunamadı" : "Sonuç bulunamadı");

  el.resultsList.innerHTML = pageItems.map((p) => `
    <div class="result-row" data-code="${p.code}">
      <div class="result-thumb" data-thumb data-src="${p.image || ""}">
        ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy">` : "Görsel"}
      </div>
      <div class="result-name">${isRecentlyAdded(p) ? '<span class="badge-new" style="position:static;display:inline-block;margin-right:6px;vertical-align:middle;">YENİ</span>' : ""}${isVisual ? p.name : highlightMatch(p.name, state.query)}</div>
      <div class="result-meta">
        <span class="result-code">${p.code}</span>
        ${p.price ? `<span class="result-price">${p.price} ₺</span>` : ""}
        <button class="share-btn" data-share aria-label="Paylaş">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/>
          </svg>
        </button>
      </div>
    </div>
  `).join("");

  // sayfalama
  if (totalPages > 1) {
    el.pagination.hidden = false;
    let btns = "";
    for (let i = 1; i <= totalPages; i++) {
      btns += `<button class="page-btn ${i === state.page ? "active" : ""}" data-page="${i}">${i}</button>`;
    }
    el.pagination.innerHTML = btns;
  } else {
    el.pagination.hidden = true;
  }

  [...el.resultsList.children].forEach((row, i) => {
    row._product = pageItems[i];
  });
}

// ---------- Arama input ----------
let debounceTimer;
el.searchInput.addEventListener("input", (e) => {
  const val = e.target.value;
  el.clearSearch.hidden = val.length === 0;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.mode = "text";
    state.query = val;
    state.page = 1;
    state.results = runTextSearch(val);
    render();
  }, 120);
});

el.clearSearch.addEventListener("click", () => {
  el.searchInput.value = "";
  el.clearSearch.hidden = true;
  state.query = "";
  state.results = [];
  render();
  el.searchInput.focus();
});

// ---------- Kamera / Görsel yükleme ----------
el.btnCamera.addEventListener("click", () => el.cameraInput.click());
el.btnUpload.addEventListener("click", () => el.uploadInput.click());

function handleImagePick(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    state.mode = "visual";
    state.visualThumb = reader.result;
    state.page = 1;
    el.searchInput.value = "";
    render();
    try {
      state.results = await runVisualSearch(reader.result);
      render();
      showToast(`${state.results.length} benzer ürün bulundu`);
    } catch (err) {
      hideStatus();
      showToast("Görsel analiz edilemedi: " + err.message);
    }
  };
  reader.readAsDataURL(file);
}

el.cameraInput.addEventListener("change", (e) => handleImagePick(e.target.files[0]));
el.uploadInput.addEventListener("change", (e) => handleImagePick(e.target.files[0]));

el.clearVisualQuery.addEventListener("click", () => {
  state.mode = "text";
  state.visualThumb = null;
  state.results = [];
  el.cameraInput.value = "";
  el.uploadInput.value = "";
  render();
});

// ---------- Sayfalama tıklama ----------
el.pagination.addEventListener("click", (e) => {
  const btn = e.target.closest(".page-btn");
  if (!btn) return;
  state.page = Number(btn.dataset.page);
  render();
  el.resultsList.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------- Görsel büyütme modali ----------
el.resultsList.addEventListener("click", (e) => {
  const thumb = e.target.closest("[data-thumb]");
  const shareBtn = e.target.closest("[data-share]");
  const row = e.target.closest(".result-row");
  if (!row) return;
  const product = row._product;

  if (thumb) {
    el.imageModalImg.src = thumb.dataset.src || "";
    el.imageModal.hidden = false;
  } else if (shareBtn) {
    sharedProductCard(product);
  }
});

el.newArrivalsList.addEventListener("click", (e) => {
  const card = e.target.closest(".new-arrival-card");
  if (!card || !card._product) return;
  el.imageModalImg.src = card._product.image || "";
  el.imageModal.hidden = false;
});

el.imageModal.addEventListener("click", () => { el.imageModal.hidden = true; });
el.imageModalImg.addEventListener("click", (e) => { e.stopPropagation(); });

// ---------- Paylaşım kartı üretimi ----------
async function sharedProductCard(product) {
  if (!product) return;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 640;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FAF9F5";
  ctx.fillRect(0, 0, 640, 640);

  if (product.image) {
    try {
      const img = await loadImage(product.image);
      ctx.drawImage(img, 40, 40, 560, 340);
    } catch {
      drawPlaceholderGradient(ctx);
    }
  } else {
    drawPlaceholderGradient(ctx);
  }

  ctx.fillStyle = "#2C2A26";
  ctx.font = "600 30px -apple-system, sans-serif";
  wrapText(ctx, product.name, 40, 430, 560, 36);

  ctx.fillStyle = "#8A8578";
  ctx.font = "500 20px ui-monospace, monospace";
  ctx.fillText("Ürün Kodu: " + product.code, 40, 555);

  if (product.price) {
    ctx.fillStyle = "#B96666";
    ctx.font = "700 22px -apple-system, sans-serif";
    ctx.fillText(product.price + " ₺", 40, 590);
  }

  ctx.fillStyle = "#7FA8C9";
  ctx.font = "800 16px -apple-system, sans-serif";
  ctx.fillText("BİMKOD", 40, 622);

  canvas.toBlob(async (blob) => {
    const file = new File([blob], `${product.code}.png`, { type: "image/png" });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: product.name,
          text: `${product.name} — Ürün Kodu: ${product.code}`,
        });
      } catch (err) {
        if (err.name !== "AbortError") showToast("Paylaşım iptal edildi");
      }
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${product.code}.png`; a.click();
      URL.revokeObjectURL(url);
      showToast("Bu tarayıcıda paylaşım desteklenmiyor, görsel indirildi");
    }
  }, "image/png");
}

function drawPlaceholderGradient(ctx) {
  const grad = ctx.createLinearGradient(0, 0, 640, 380);
  grad.addColorStop(0, "#EAF1F6");
  grad.addColorStop(1, "#FBEDED");
  ctx.fillStyle = grad;
  ctx.fillRect(40, 40, 560, 340);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  let curY = y;
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + " ";
    if (ctx.measureText(testLine).width > maxWidth && n > 0) {
      ctx.fillText(line, x, curY);
      line = words[n] + " ";
      curY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, curY);
}

// ---------- Toast ----------
let toastTimer;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

// ---------- Service worker kaydı ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

// ---------- Başlat ----------
loadData().then(render);
