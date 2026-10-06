// ============================================================
// BİMKOD — Gerçek arama motoru
//   - Metin arama : Fuse.js (data/products.json üzerinde, Türkçe normalize)
//   - Görsel arama: Transformers.js (CLIP, tarayıcıda, ONNX/WASM) + cosine similarity
//                   data/embeddings.json içindeki 30k+ vektörle karşılaştırılır
// Coldstart yok: her şey statik dosya (GitHub Pages). CLIP modeli ilk açılışta
// indirilir, sonra tarayıcı cache'i (+service worker) sayesinde anında yüklenir.
// ============================================================

// HIZ: Transformers.js (büyük) ve Firebase (firebase-config.js) artık sayfa açılışında
// DEĞİL, yalnızca gerektiğinde (ilk görsel arama / ürün bildirimi) dinamik yüklenir.
// Önceden statik import oldukları için uygulama bunlar inene kadar hiç başlamıyordu.
let transformersMod = null;
async function getTransformers() {
  if (!transformersMod) transformersMod = import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0");
  return transformersMod;
}
function cosSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

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
  imageModalClose: document.getElementById("imageModalClose"),
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

// "Yeni Eklenenler" = EN SON taramada eklenen TÜM ürünler (sabit 20 sınırı yok).
// Son tarama: elle onaylananlar hariç en yeni addedAt'in 1 saat öncesinden itibaren
// eklenenler (bir tarama çalışması dakikalar içinde biter). Bu zamandan sonra elle
// eklenen ürünler de listeye dahil olur.
function getLatestArrivals() {
  const dated = PRODUCTS.filter((p) => p.addedAt);
  if (!dated.length) return [];
  const scraped = dated.filter((p) => !p.approvedManually);
  const ref = scraped.length ? scraped : dated;
  const newest = Math.max(...ref.map((p) => new Date(p.addedAt).getTime()));
  const cutoff = newest - 60 * 60 * 1000;
  return dated
    .filter((p) => new Date(p.addedAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
}

function renderNewArrivals() {
  const hasQuery = state.mode === "text" ? state.query.trim().length > 0 : true;
  if (hasQuery) { el.newArrivals.hidden = true; return; }

  const recent = getLatestArrivals();
  if (recent.length === 0) { el.newArrivals.hidden = true; return; }

  el.newArrivals.hidden = false;
  const countEl = document.getElementById("newArrivalsCount");
  if (countEl) countEl.textContent = `(${recent.length})`;
  el.newArrivalsList.innerHTML = recent.map((p) => `
    <div class="new-arrival-card" data-code="${escapeHtml(p.code)}">
      <span class="badge-new">YENİ</span>
      <button class="share-btn share-btn--card" data-share aria-label="Paylaş">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/>
        </svg>
      </button>
      <div class="thumb" data-thumb>${p.image ? `<img src="${p.image}" alt="${escapeHtml(p.name)}" loading="lazy">` : ""}</div>
      <div class="name">${escapeHtml(p.name)}</div>
    </div>
  `).join("");

  [...el.newArrivalsList.children].forEach((card, i) => {
    card._product = recent[i];
  });
}

// "Tümünü gör" / "Daralt": şerit <-> çok satırlı ızgara
document.getElementById("newArrivalsToggle")?.addEventListener("click", (e) => {
  const expanded = el.newArrivalsList.classList.toggle("expanded");
  e.currentTarget.textContent = expanded ? "Daralt" : "Tümünü gör";
});

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
  // Sadece products.json beklenir -> ilk ekran hemen gelir. 32 MB'lık embeddings.bin
  // yalnızca görsel arama için gerekli, arka planda / ihtiyaç anında indirilir.
  const productsRes = await fetch("data/products.json").then((r) => r.json()).catch(() => []);
  PRODUCTS = productsRes.map((p) => ({ ...p, normName: trNormalize(p.name) }));

  fuse = new Fuse(PRODUCTS, {
    keys: ["normName"],
    threshold: 0.35,
    ignoreLocation: true,
  });

  hideStatus();
}

let embeddingsPromise = null;
function ensureEmbeddings() {
  if (!embeddingsPromise) {
    embeddingsPromise = (async () => {
      const embMeta = await fetch("data/embeddings.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null);
      if (!embMeta) return;
      // ?c=count -> yeni ürün eklenince URL değişir (güncel indirilir), değişmediyse
      // service worker önbelleğinden anında gelir.
      const embBuf = await fetch(`data/embeddings.bin?c=${embMeta.count}`).then((r) => r.arrayBuffer()).catch(() => null);
      if (!embBuf) return;
      const dim = embMeta.dim;
      const bytesPerVec = dim * 4; // float32 = 4 byte
      const n = Math.min(embMeta.count, Math.floor(embBuf.byteLength / bytesPerVec));
      EMBEDDINGS = [];
      for (let i = 0; i < n; i++) EMBEDDINGS.push(new Float32Array(embBuf, i * bytesPerVec, dim));
    })().catch(() => { embeddingsPromise = null; });
  }
  return embeddingsPromise;
}

// Hızlı + kotası bol bağlantıda (4g, veri tasarrufu kapalı) boşta iken önceden indir;
// aksi halde sadece kullanıcı kamera/yükle'ye dokununca indirilir.
function maybePrefetchEmbeddings() {
  const c = navigator.connection;
  if (c && (c.saveData || c.effectiveType !== "4g")) return;
  const run = () => ensureEmbeddings();
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 8000 });
  else setTimeout(run, 3000);
}

// ---------- Metin arama (Fuse.js fuzzy search) ----------
function runTextSearch(query) {
  const q = trNormalize(query);
  if (!q) return [];
  return fuse.search(q).map((r) => ({ ...r.item, score: 1 - r.score }));
}

// ---------- Görsel arama (CLIP embedding + cosine similarity) ----------
async function runVisualSearch(imageDataUrl) {
  const embReady = ensureEmbeddings(); // paralel indir
  if (!clipExtractor) {
    showStatus("Görsel arama motoru ilk kez hazırlanıyor (~30sn)…");
    const { pipeline } = await getTransformers();
    // Xenova/clip-vit-base-patch32: quantized ONNX, tarayıcıda WASM ile çalışır
    clipExtractor = await pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32", {
      quantized: true,
    });
  }
  showStatus("Görsel analiz ediliyor…");

  const output = await clipExtractor(imageDataUrl, { pooling: "mean", normalize: true });
  const queryVec = Float32Array.from(output.data);

  if (!EMBEDDINGS) { showStatus("Görsel arşivi yükleniyor…"); await embReady; }
  hideStatus();

  if (!EMBEDDINGS || EMBEDDINGS.length === 0) {
    return [];
  }

  const scored = PRODUCTS.map((p, i) => {
    const vec = EMBEDDINGS[p.embIndex ?? i];
    if (!vec) return null;
    return { ...p, score: cosSim(queryVec, vec) };
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
// OCR'dan gelen isimlerde ara sıra < > " gibi karakterler sızabiliyor (bozuk
// karakterlerin OCR tarafından yanlış okunmasından). Bunlar escape edilmeden
// innerHTML'e basılırsa HTML yapısını kırıp o karttan sonraki HER ŞEYİN
// içine "yutulmasına" sebep olabiliyor -> tek bir dev kart + altında üst üste
// binen diğer kartlar görüntüsü. Bu yüzden HER ürün adı/kodu innerHTML'e
// girmeden önce mutlaka escape edilmeli.
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function highlightMatch(name, query) {
  const safeName = escapeHtml(name);
  if (!query) return safeName;
  const normName = trNormalize(safeName);
  const normQuery = trNormalize(query);
  const idx = normName.indexOf(normQuery);
  if (idx === -1) return safeName;
  return (
    safeName.slice(0, idx) +
    "<mark>" + safeName.slice(idx, idx + query.length) + "</mark>" +
    safeName.slice(idx + query.length)
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
    <div class="result-row" data-code="${escapeHtml(p.code)}">
      <div class="result-thumb" data-thumb data-src="${p.image || ""}">
        ${p.image ? `<img src="${p.image}" alt="${escapeHtml(p.name)}" loading="lazy">` : "Görsel"}
      </div>
      <div class="result-content">
        <div class="result-name">${isRecentlyAdded(p) ? '<span class="badge-new" style="position:static;display:inline-block;margin-right:6px;vertical-align:middle;">YENİ</span>' : ""}${isVisual ? escapeHtml(p.name) : highlightMatch(p.name, state.query)}</div>
        <div class="result-meta">
          <span class="result-code">${escapeHtml(p.code)}</span>
          ${p.price ? `<span class="result-price">${escapeHtml(p.price)} ₺</span>` : ""}
          <button class="share-btn" data-share aria-label="Paylaş">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `).join("");

  // sayfalama (çok sayfa varsa akıllı/kısaltılmış: 1 … 8 9 [10] 11 12 … 136)
  if (totalPages > 1) {
    el.pagination.hidden = false;
    const cur = state.page;
    const pagesToShow = new Set([1, totalPages, cur, cur - 1, cur + 1, cur - 2, cur + 2]);
    let btns = "";
    let lastRendered = 0;
    for (let i = 1; i <= totalPages; i++) {
      if (!pagesToShow.has(i)) continue;
      if (i - lastRendered > 1) btns += `<span class="page-ellipsis">…</span>`;
      btns += `<button class="page-btn ${i === cur ? "active" : ""}" data-page="${i}">${i}</button>`;
      lastRendered = i;
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
  const shareBtn = e.target.closest("[data-share]");
  if (shareBtn) {
    sharedProductCard(card._product);
    return;
  }
  el.imageModalImg.src = card._product.image || "";
  el.imageModal.hidden = false;
});

el.imageModal.addEventListener("click", () => { el.imageModal.hidden = true; });
el.imageModalImg.addEventListener("click", (e) => { e.stopPropagation(); });
el.imageModalClose.addEventListener("click", () => { el.imageModal.hidden = true; });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el.imageModal.hidden) el.imageModal.hidden = true;
});

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
      // Görseli esnetmeden (en-boy oranını koruyarak) kutuya ortala — "contain" mantığı
      const boxX = 40, boxY = 40, boxW = 560, boxH = 340;
      const scale = Math.min(boxW / img.width, boxH / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, boxX + (boxW - w) / 2, boxY + (boxH - h) / 2, w, h);
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

// ==================== Ürün Bildirim Formu ====================
// Kullanıcı kodunu bulamadığı bir ürünü (görsel + varsa isim) bildirebiliyor.
// Gönderim firebase-config.js'teki submitProductReport() ile Firebase'in
// "pending_reports" koleksiyonuna gidiyor. admin.html aynı koleksiyonu okuyup
// "Çalışan İsteği" panelinde listeliyor. Public sitede GitHub yazma token'ı
// ASLA bulunamayacağı için (güvenlik açığı olur) bu akış GitHub API değil
// Firebase üzerinden gidiyor.
const reportModal = document.getElementById("reportModal");
const reportStatus = document.getElementById("reportStatus");

document.getElementById("reportMissingBtn").addEventListener("click", () => {
  reportModal.hidden = false;
});
document.getElementById("reportModalClose").addEventListener("click", () => {
  reportModal.hidden = true;
});
reportModal.addEventListener("click", (e) => {
  if (e.target === reportModal) reportModal.hidden = true;
});

document.getElementById("reportSubmitBtn").addEventListener("click", async () => {
  const file = document.getElementById("reportImageInput").files[0];
  const name = document.getElementById("reportNameInput").value.trim();

  if (!file) {
    reportStatus.textContent = "⚠️ Lütfen önce bir ürün görseli seçin.";
    return;
  }

  reportStatus.textContent = "Gönderiliyor…";
  const submitBtn = document.getElementById("reportSubmitBtn");
  submitBtn.disabled = true;

  try {
    const { submitProductReport } = await import("./firebase-config.js");
    await submitProductReport({ imageFile: file, name });
    reportStatus.textContent = "✅ Alındı, teşekkürler! Ekibimiz en kısa sürede inceleyip ekleyecek.";
    setTimeout(() => {
      reportModal.hidden = true;
      reportStatus.textContent = "";
      document.getElementById("reportImageInput").value = "";
      document.getElementById("reportNameInput").value = "";
    }, 1900);
  } catch (err) {
    reportStatus.textContent = "❌ Gönderilemedi: " + err.message;
  }
  submitBtn.disabled = false;
});

// ==================== Yasal Metinler (Gizlilik / KVKK-GDPR / Çerez) ====================
const POLICIES = {
  privacy: `
    <h3>Gizlilik Politikası</h3>
    <p><em>Son güncelleme: Ekim 2026</em></p>
    <p>BİMKOD, ürün kodlarını ve görsellerini aramanıza yardımcı olan bağımsız bir bilgilendirme aracıdır. Bu site herhangi bir market zinciri ile resmî bir bağı olduğunu iddia etmez; marka ve ürün adları ilgili sahiplerine aittir.</p>
    <h4>Hangi verileri işliyoruz?</h4>
    <p><strong>Arama:</strong> Yazdığınız arama metni ve görsel arama için seçtiğiniz fotoğraf cihazınızda işlenir; sunucularımıza gönderilmez.</p>
    <p><strong>Ürün bildirimi:</strong> "Ürün Bildir" formunu kullanırsanız gönderdiğiniz fotoğraf ve (varsa) yazdığınız ürün adı, inceleme amacıyla Google Firebase altyapısında saklanır. Lütfen fotoğrafta kişi, yüz veya kişisel bilgi bulunmamasına dikkat edin. Fotoğraf, inceleme sonrasında (onay veya ret) bildirim kaydından silinir.</p>
    <p><strong>Ziyaretçi sayacı:</strong> Anlık ve toplam ziyaretçi sayısını göstermek için rastgele oluşturulan, sizi tanımlamayan bir oturum kimliği kullanılır; ad, e-posta veya IP adresi tutulmaz.</p>
    <h4>Üçüncü taraflar</h4>
    <p>Site; Google Firebase (barındırma ve veri), GitHub Pages (yayın) ve Google AdSense (reklam) hizmetlerini kullanır. Bu hizmetler kendi gizlilik politikalarına tabidir.</p>
    <h4>İletişim</h4>
    <p>Sorularınız için Instagram: <strong>@h_seyinn</strong></p>`,
  kvkk: `
    <h3>KVKK / GDPR Aydınlatma Metni</h3>
    <p><em>Son güncelleme: Ekim 2026</em></p>
    <p>6698 sayılı Kişisel Verilerin Korunması Kanunu (KVKK) ve Avrupa Birliği Genel Veri Koruma Tüzüğü (GDPR) kapsamında, veri sorumlusu sıfatıyla BİMKOD aşağıdaki bilgileri paylaşır.</p>
    <h4>İşlenen veriler ve amaç</h4>
    <p>Ürün bildirimi formunda paylaştığınız görsel ve ürün adı; yalnızca eksik ürünün kataloğa eklenmesi amacıyla işlenir. Hukuki sebep: meşru menfaat ve açık rızanız (formu kendi isteğinizle göndermeniz). Sizi doğrudan tanımlayan kimlik bilgisi talep edilmez.</p>
    <h4>Saklama ve aktarım</h4>
    <p>Veriler, inceleme tamamlanana kadar Google Firebase (AB/ABD veri merkezleri) üzerinde tutulur; onay veya ret sonrasında görsel kayıttan silinir. Verileriniz satılmaz ve reklam amacıyla üçüncü kişilerle paylaşılmaz.</p>
    <h4>Haklarınız</h4>
    <p>Verilerinize erişme, düzeltme, silme, işlemeye itiraz etme, veri taşınabilirliği ve rızanızı geri çekme haklarına sahipsiniz (KVKK m.11, GDPR m.15–22). Talepleriniz için Instagram üzerinden <strong>@h_seyinn</strong> hesabına yazabilirsiniz. Ayrıca yetkili denetim makamına (KVKK Kurulu / ilgili AB veri koruma otoritesi) şikâyette bulunma hakkınız saklıdır.</p>`,
  cookies: `
    <h3>Çerez Politikası</h3>
    <p><em>Son güncelleme: Ekim 2026</em></p>
    <p>Çerezler ve benzeri teknolojiler, sitenin çalışması ve reklamların gösterilmesi için kullanılır.</p>
    <h4>Zorunlu / işlevsel</h4>
    <p>Tarayıcı depolaması (localStorage/sessionStorage) ve önbellek (service worker): veri sürümünü hatırlamak, siteyi hızlı açmak ve çevrimdışı çalışmasını sağlamak içindir. Ziyaretçi sayacı için oturum depolamasında "bu oturumda sayıldı" işareti tutulur.</p>
    <h4>Reklam</h4>
    <p>Google AdSense, reklam göstermek ve ölçmek için çerez kullanabilir. Reklam kişiselleştirmesini <a href="https://adssettings.google.com" target="_blank" rel="noopener noreferrer">Google Reklam Ayarları</a> üzerinden yönetebilir veya kapatabilirsiniz; AB/EEA ve Birleşik Krallık'taki ziyaretçilerden gerekli onay, Google'ın onay mekanizması üzerinden alınır.</p>
    <h4>Çerezleri yönetme</h4>
    <p>Tarayıcı ayarlarınızdan çerezleri silebilir veya engelleyebilirsiniz; bu durumda sitenin bazı özellikleri beklenen şekilde çalışmayabilir.</p>`,
};

const policyModal = document.getElementById("policyModal");
document.querySelectorAll("[data-policy]").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("policyContent").innerHTML = POLICIES[a.dataset.policy] || "";
    policyModal.hidden = false;
  });
});
document.getElementById("policyModalClose")?.addEventListener("click", () => { policyModal.hidden = true; });
policyModal?.addEventListener("click", (e) => { if (e.target === policyModal) policyModal.hidden = true; });

// ---------- Service worker kaydı ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

// ---------- Başlat ----------
el.btnCamera.addEventListener("click", ensureEmbeddings);
el.btnUpload.addEventListener("click", ensureEmbeddings);
loadData().then(() => { render(); maybePrefetchEmbeddings(); });
