// ==================== Firebase Yapılandırması ====================
// BİMKOD için AYRI, kendi Firebase projesi kullanılıyor (Kampanya Talep /
// taleBİM projelerinden bilerek ayrı tutuldu). Sebep: bu site tamamen public,
// config aşağıda herkese açık görünür (Firebase için bu normaldir, güvenlik
// `rules` ile sağlanır) — internal BİM verisiyle aynı projeyi paylaşmak,
// bir kural hatasında iç veriyi riske atabilir.
//
// TODO(Hüseyin): Firebase Console > Project Settings > "Web uygulaması"
// adımında sana verilen GERÇEK değerlerle aşağıdaki firebaseConfig'i değiştir.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import {
  getFirestore, collection, addDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-storage.js";
export { ref, deleteObject };

const firebaseConfig = {
  apiKey: "AIzaSyDP_l3Ef4ba9N9bFWlwP2ACVIkvfsiHyzs",
  authDomain: "bimkod-8afef.firebaseapp.com",
  databaseURL: "https://bimkod-8afef-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "bimkod-8afef",
  storageBucket: "bimkod-8afef.firebasestorage.app",
  messagingSenderId: "556797618371",
  appId: "1:556797618371:web:82a6de4f45498cc61c9a76",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Telefon fotoğrafları genelde 3-8 MB oluyor; Firebase'in ücretsiz 5GB
// depolama kotasını hızla tüketmemek için yüklemeden önce en uzun kenarı
// 1000px'e indirip JPEG %80 kalitede yeniden sıkıştırıyoruz (~100-300 KB'a
// düşer). admin onayladığında görsel zaten GitHub'a (images/) kopyalanıyor,
// o yüzden Storage'daki bu kopyanın "arşiv kalitesinde" olmasına gerek yok.
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
}
