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
     eder (foto + isim + fiyat + kod hepsi birlikte). Her tespit için iki
     kırpım üretir: `full_crop` (OCR için, metin dahil) ve `photo_crop`
     (temiz fotoğraf, üst %58'i — bkz. `PHOTO_HEIGHT_RATIO`, kalibre etmen
     gerekebilir).
  3. `ocr_extract.py` — `full_crop` üzerinde Tesseract OCR çalıştırır,
     **kod** (7 haneli, `1` ile başlayan), **isim** ve **fiyat**'ı regex ile
     ayrıştırır. Kod/isim bulunamayan crop'lar `pipeline/ocr_review.json`'a
     düşer (elle bakılacak).
  4. `embed_products.py` — `photo_crop` üzerinden CLIP embedding çıkarır.
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
   Loglara bak, `data/products.json` dolmalı. `pipeline/ocr_review.json`'ı
   kontrol et — OCR'ın kod/isim okuyamadığı crop'lar burada, bunlara bakarak
   `PHOTO_HEIGHT_RATIO`'yu ve OCR regex'lerini (`ocr_extract.py`) kalibre et.

6. **OCR hatalarını kalıcı düzelt**: Bir ürünün ismi hep yanlış okunuyorsa
   `pipeline/catalog_source/corrections.csv` dosyasına `code,name` olarak
   ekle (şablon: `corrections.csv.example`) — `build_data.py` bunu otomatik
   uygular, koda göre kalıcı override sağlar.

## Sıradaki geliştirme fikirleri
- `ocr_review.json`'ı görsel bir "onay ekranı"na çevirip elle düzeltmeyi
  hızlandırmak (crop'u göster, isim/kod gir, corrections.csv'ye otomatik yaz)
- `PHOTO_HEIGHT_RATIO`'yu sabit oran yerine OCR'ın bulduğu ilk metin
  satırının y-konumuna göre dinamik hesaplamak (farklı ürün kartı
  boyutlarında daha sağlam kırpma)
- Webhook tabanlı gerçek anlık tetikleme (Telegram bot + Cloudflare Worker)
  — 10dk polling yeterli gelmezse
