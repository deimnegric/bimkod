// ==================== Ürün Bildir (herkese açık sayfa) ====================
// Sadece Firestore'a ihtiyaç duyan hafif modül (Storage yok): sayfa kodu bağımlılık
// yüzünden yüklenemeyip formu çalışmaz bırakmasın diye firebase-config.js'ten ayrıldı.
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDP_l3Ef4ba9N9bFWlwP2ACVIkvfsiHyzs",
  authDomain: "bimkod-8afef.firebaseapp.com",
  projectId: "bimkod-8afef",
  storageBucket: "bimkod-8afef.firebasestorage.app",
  messagingSenderId: "556797618371",
  appId: "1:556797618371:web:82a6de4f45498cc61c9a76",
};
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);

function compressImage(file, maxDim = 1000, quality = 0.8) {
  // createImageBitmap bazı eski mobil tarayıcılarda (özellikle iOS Safari'nin
  // eski sürümleri) desteklenmiyor/sessizce takılıyor olabiliyordu -> daha
  // geniş desteğe sahip <img> + canvas yöntemine geçtik.
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    const timeout = setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Görsel yüklenemedi (zaman aşımı)."));
    }, 15000);

    img.onload = () => {
      clearTimeout(timeout);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Görsel sıkıştırılamadı."))),
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      clearTimeout(timeout);
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Görsel okunamadı (bozuk dosya olabilir)."));
    };
    img.src = objectUrl;
  });
}

// Kullanıcının "ürün bildirimi"ni pending_reports koleksiyonuna yazar.
// Görsel önce küçültülüp Storage'a yüklenir, sonra dokümana indirme linki
// (ve admin onay/red sonrası temizleyebilsin diye Storage yolu) eklenir.
// admin.html bu koleksiyonu "Çalışan İsteği" panelinde okuyup listeler.
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Görsel okunamadı."));
    r.readAsDataURL(blob);
  });
}

// NOT: Görsel artık Firebase Storage'a YÜKLENMİYOR. Storage'a tarayıcıdan yapılan
// istekler CORS/ön-kontrol (preflight) hatasıyla engelleniyordu (kova/plan/kural
// ayarlarına bağlı). Bunun yerine küçültülmüş görsel (~50-150 KB) data-URL olarak
// doğrudan Firestore dokümanına (imageData) yazılıyor: aynı çalışan Firestore
// bağlantısını kullandığı için CORS sorunu yok, ek kurulum gerekmiyor.
// Firestore doküman sınırı 1 MiB -> gerekirse daha da küçültüp kalite düşürüyoruz.
export async function submitProductReport({ imageFile, name }) {
  let imageData = null;
  if (imageFile) {
    const tries = [[900, 0.75], [700, 0.65], [520, 0.55]];
    for (const [dim, q] of tries) {
      const blob = await compressImage(imageFile, dim, q);
      imageData = await blobToDataUrl(blob);
      if (imageData.length < 700000) break; // base64 ~700KB altı -> 1MiB sınırının güvenle altında
    }
    if (imageData.length >= 900000) throw new Error("Görsel çok büyük, lütfen daha küçük bir fotoğraf deneyin.");
  }
  try {
  await withTimeout(
    addDoc(collection(db, "pending_reports"), {
      name: name || null,
      imageData,       // data:image/jpeg;base64,... (Storage kullanılmıyor)
      imageUrl: null,
      storagePath: null,
      status: "pending", // admin onaylayınca "approved", reddedince "rejected"
      createdAt: serverTimestamp(),
    }),
    25000,
    "Gönderilemedi (zaman aşımı) — internet bağlantını kontrol edip tekrar dene."
  );
  } catch (e) {
    const code = e && e.code ? String(e.code) : "";
    const map = {
      "permission-denied": "Sunucu izin vermedi (Firestore kuralları 'pending_reports' için yazmaya izin vermiyor).",
      "unavailable": "Sunucuya ulaşılamadı, bağlantını kontrol edip tekrar dene.",
      "resource-exhausted": "Günlük istek kotası dolmuş, biraz sonra tekrar dene.",
      "invalid-argument": "Gönderilen veri geçersiz (görsel çok büyük olabilir).",
      "failed-precondition": "Firestore veritabanı bu projede henüz oluşturulmamış/etkin değil.",
    };
    const err = new Error((map[code] || e.message || "Bilinmeyen hata") + (code ? ` [${code}]` : ""));
    err.code = code;
    throw err;
  }
}
