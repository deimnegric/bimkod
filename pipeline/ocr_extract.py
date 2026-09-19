"""
BİMKOD Pipeline — Adım 3: OCR ile isim/kod/fiyat çıkarma
detect_products.py'ın ürettiği "full_crop" (foto+isim+fiyat+kod hepsi bir arada)
üzerinde OCR çalıştırır ve şu alanları ayrıştırır:
  - code : 6-7 haneli ürün kodu (örn. 1646722) — genelde karenin en altında
  - name : ürün adı (fiyat/taksit metinlerinden temizlenmiş satırlar)
  - price: "349" gibi TL tutarı (best-effort, opsiyonel bilgi)

BİM broşür kodları gözlemlenen örneklerde hep 7 haneli ve "1" ile başlıyor
(1646722, 1647433, 1607031, 1645159...). CODE_RE bunu hedefliyor; farklı
kod formatları görürsen burayı güncelle.

OCR mükemmel olmayacak (Türkçe karakterler, düşük çözünürlük vb.) — kod
regex ile YAKALANAMAYAN crop'lar pipeline/ocr_review.json'a düşer, elle
düzeltme/onay için. Bu dosyada review_queue'yu düzenli kontrol etmek,
zamanla OCR kalitesini (crop kalibrasyonu, dil paketi vb.) iyileştirmenin
en hızlı yolu.
"""

import json
import re
from pathlib import Path

import pytesseract
from PIL import Image

DETECTIONS_FILE = Path("pipeline/detections.json")
OCR_OUT = Path("pipeline/ocr_results.json")
REVIEW_OUT = Path("pipeline/ocr_review.json")

CODE_RE = re.compile(r"\b1\d{6}\b")          # 7 haneli, 1 ile başlayan kod
PRICE_RE = re.compile(r"\b(\d{1,4})\s?[t₺]\b", re.IGNORECASE)

# OCR çıktısında isimden ayıklanacak marketing/gürültü kelimeleri
NOISE_PATTERNS = [
    r"peşin\s*fiyat", r"taksit", r"adet", r"stok", r"garanti",
    r"kart\s*ile", r"nakit", r"^\d+\s*(yil|yıl)$",
]
NOISE_RE = re.compile("|".join(NOISE_PATTERNS), re.IGNORECASE)


def clean_name(lines, code_line_idx, price_line_idx):
    """Kod ve fiyat satırları arasındaki/dışındaki gürültüyü ayıklayıp isim satırlarını birleştirir."""
    name_lines = []
    for i, line in enumerate(lines):
        if i in (code_line_idx, price_line_idx):
            continue
        stripped = line.strip()
        if not stripped:
            continue
        if NOISE_RE.search(stripped):
            continue
        if re.fullmatch(r"[\d\W]+", stripped):  # sadece sayı/sembol olan satırları at
            continue
        name_lines.append(stripped)
    return " ".join(name_lines).strip()


def parse_ocr_text(raw_text):
    lines = [l for l in raw_text.split("\n") if l.strip()]

    code, code_idx = None, None
    for i, line in enumerate(lines):
        m = CODE_RE.search(line.replace(" ", ""))
        if m:
            code, code_idx = m.group(0), i
            break  # genelde en alttaki satırda, ilk bulunan yeterli

    price, price_idx = None, None
    for i, line in enumerate(lines):
        m = PRICE_RE.search(line)
        if m:
            price, price_idx = m.group(1), i
            break

    name = clean_name(lines, code_idx, price_idx)
    return code, name, price


def main():
    detections = json.loads(DETECTIONS_FILE.read_text()) if DETECTIONS_FILE.exists() else []
    if not detections:
        print("OCR için yeni crop yok.")
        OCR_OUT.write_text(json.dumps([]))
        return

    results, review_queue = [], []

    for det in detections:
        img = Image.open(det["full_crop"])
        raw_text = pytesseract.image_to_string(img, lang="tur")
        code, name, price = parse_ocr_text(raw_text)

        record = {**det, "code": code, "name": name, "price": price, "raw_ocr": raw_text}

        if not code or not name:
            review_queue.append(record)
        else:
            results.append(record)

    OCR_OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2))

    existing_review = json.loads(REVIEW_OUT.read_text()) if REVIEW_OUT.exists() else []
    REVIEW_OUT.write_text(json.dumps(existing_review + review_queue, ensure_ascii=False, indent=2))

    print(f"OCR başarılı: {len(results)} | Elle bakılacak: {len(review_queue)}")


if __name__ == "__main__":
    main()
