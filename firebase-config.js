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
async function compressImage(file, maxDim = 1000, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

// Kullanıcının "ürün bildirimi"ni pending_reports koleksiyonuna yazar.
// Görsel önce küçültülüp Storage'a yüklenir, sonra dokümana indirme linki
// (ve admin onay/red sonrası temizleyebilsin diye Storage yolu) eklenir.
// admin.html bu koleksiyonu "Çalışan İsteği" panelinde okuyup listeler.
export async function submitProductReport({ imageFile, name }) {
  let imageUrl = null;
  let storagePath = null;
  if (imageFile) {
    const compressed = await compressImage(imageFile);
    storagePath = `pending_reports/${Date.now()}.jpg`;
    const storageRef = ref(storage, storagePath);
    await uploadBytes(storageRef, compressed, { contentType: "image/jpeg" });
    imageUrl = await getDownloadURL(storageRef);
  }
  await addDoc(collection(db, "pending_reports"), {
    name: name || null,
    imageUrl,
    storagePath, // admin onay/red sonrası Storage'dan silmek için
    status: "pending", // admin onaylayınca "approved", reddedince "rejected" yapacağız
    createdAt: serverTimestamp(),
  });
}
