# BİMKOD — 0 Maliyetli, Coldstart'sız Mimari

## Mimari özeti
- **Frontend**: Statik HTML/JS, GitHub Pages'de barınıyor. Coldstart yok.
  - Metin arama: Fuse.js (fuzzy, Türkçe normalize)
  - Görsel arama: Transformers.js ile tarayıcıda CLIP embedding çıkarılır,
    `data/embeddings.json` içindeki vektörlerle cosine similarity hesaplanır.
  - **Yeni Eklenenler**: `addedAt` alanına göre son 20 ürün üstte kayan bir
    şerit olarak gösterilir; son 72 saatte eklenenlerde "YENİ" rozeti çıkar.
  - **Paylaşım kartı**: ürünün gerçek fotoğrafı + isim + kod + fiyat + BİMKOD
    markasıyla bir PNG üretir, WhatsApp/Instagram'a "İsim — Ürün Kodu: X"
    metniyle paylaşılır (mevcut kullandığın format).

- **Pipeline (GitHub Actions, `update-index.yml`, günde 3 kez — TR saatiyle 08:00/16:00/00:00)**:
  1. `scrape_telegram.py` — kisakod'dan yeni afiş görsellerini indirir
     (Telegram mesaj tarihini de kaydeder → `flyer_date`)
  2. `detect_products.py` — YOLO ile afişteki her ürün **karesini** tespit
     eder (foto + isim + fiyat + kod hepsi birlikte), `full_crop` olarak
     kaydeder. (Önceden "sadece fotoğraf" ayrı bir kırpım da üretiliyordu,
     ama bazı şablonlarda fotoğrafın tamamını silip görsel aramayı bozduğu
     görüldüğü için kaldırıldı — artık tek tip kırpım var.)
  3. `ocr_extract.py` — `full_crop` üzerinde Tesseract OCR çalıştırır,
     **kod** (6-8 haneli bağımsız sayı), **isim** ve **fiyat**'ı regex ile
     ayrıştırır. Kod/isim bulunamayan crop'lar `pipeline/ocr_review.json`'a
     düşer (görseli `review/` klasörüne kalıcı kaydedilir — bkz.
     `admin.html`, elle onay ekranı).
  4. `embed_products.py` — `full_crop` üzerinden CLIP embedding çıkarır.
  5. `build_data.py` — kod bazlı **dedupe** yaparak (aynı ürün tekrar
     çıkarsa güncellenir, çoğaltılmaz) `data/products.json` +
     `data/embeddings.json`'a ekler, commit'ler → Pages otomatik yayınlar.

## Neden ayrı bir "katalog" yok?
İlk tasarımda haftalık resmi kataloğu ayrı bir referans olarak CLIP ile
eşleştirmeyi düşünmüştük. Ama gönderdiğin örnekler gösterdi ki **kisakod'daki
afişin kendisi zaten kod+isim+fiyatı içeriyor** (her ürün karesinde basılı).
Yani ayrı bir katalog kaynağına gerek yok — YOLO kutusunu kırpıp OCR ile
okumak yeterli ve daha güvenilir (kaynak tek, gecikme yok).

## Neden "polling" (günde 3 kez) ve neden PUBLIC repo?
Telegram, GitHub Actions'a webhook push edemiyor; bu yüzden zamanlanmış
aralıklarla yokluyoruz. Afişler haftada 3 gün (Pzt/Per/Cmt) paylaşıldığı
için günde 3 kontrol (08:00/16:00/00:00 TR) pratikte yeterli. **Repo yine
de public kalmalı** — private repoda Actions'ın ücretsiz kotası 2000dk/ay,
public repoda Actions dakikası sınırsız ve ücretsizdir, ileride sıklığı
artırmak istersen (örn. tekrar 10dk'ya) maliyet sorunu olmaz.

## Kurulum adımları

1. **Repo oluştur (PUBLIC) ve bu dosyaları push'la**
   ```bash
   git init && git add . && git commit -m "BİMKOD ilk kurulum"
   git branch -M main
   git remote add origin <SENIN_REPO_URL>
   git push -u origin main
   ```

2. **GitHub Pages'i aç**: Settings → Pages → `main` branch, `/ (root)`.

3. **Telegram secret'larını ekle**: Settings → Secrets and variables →
   Actions → `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`
   (session üretimi: `scrape_telegram.py` üst yorumundaki script).

4. **YOLO ağırlığını ekle**: `pipeline/model/best.pt` (küçükse direkt
   commit, büyükse GitHub Release asset'i — workflow oradan indirir).

5. **İlk test**: Actions → "BİMKOD Index Güncelle" → Run workflow (manuel).
   Loglara bak, `data/products.json` dolmalı.

6. **Bekleyen ürünleri onayla**: `admin.html`'i tarayıcıda aç (yerelde dosyayı
   çift tıklayarak ya da `https://<kullanıcı>.github.io/<repo>/admin.html`
   üzerinden). GitHub Personal Access Token'ını (repo yazma izinli) gir,
   "Bekleyen Ürünleri Yükle"ye bas. OCR'ın kod/isim çıkaramadığı ürünler
   görsel + ham OCR metniyle listelenir; kod/ismi düzeltip **Onayla**'ya
   basınca ürün embedding'i de hesaplanıp anında canlı siteye eklenir,
   **Reddet**'e basınca (gerçek ürün değilse) kuyruktan silinir.

7. **OCR hatalarını kalıcı düzelt**: Admin sayfasından onaylanan her ürün
   otomatik olarak `pipeline/catalog_source/corrections.csv`'ye eklenir —
   o kod bir daha OCR'dan geçtiğinde artık doğru ismi kullanılır.

## Sıradaki geliştirme fikirleri
- Webhook tabanlı gerçek anlık tetikleme (Telegram bot + Cloudflare Worker)
  — günde 3 kontrol yeterli gelmezse
- Metin aramasını uzun/tam cümle sorgularda daha toleranslı hale getirmek
  (şu an kısa anahtar kelimeler daha iyi sonuç veriyor)
