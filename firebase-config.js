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
  getStorage, ref, uploadBytes, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-storage.js";

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

// Kullanıcının "ürün bildirimi"ni pending_reports koleksiyonuna yazar.
// Görsel önce Storage'a yüklenir, sonra dokümana indirme linki eklenir.
// admin.html bu koleksiyonu "Çalışan İsteği" panelinde okuyup listeler.
export async function submitProductReport({ imageFile, name }) {
  let imageUrl = null;
  if (imageFile) {
    const safeName = imageFile.name.replace(/[^\w.\-]/g, "_");
    const path = `pending_reports/${Date.now()}_${safeName}`;
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, imageFile);
    imageUrl = await getDownloadURL(storageRef);
  }
  await addDoc(collection(db, "pending_reports"), {
    name: name || null,
    imageUrl,
    status: "pending", // admin onaylayınca "approved", reddedince "rejected" yapacağız
    createdAt: serverTimestamp(),
  });
}
