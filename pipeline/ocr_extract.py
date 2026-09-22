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

import hashlib
import json
import re
import shutil
from pathlib import Path

import pytesseract
from PIL import Image

DETECTIONS_FILE = Path("pipeline/detections.json")
OCR_OUT = Path("pipeline/ocr_results.json")
REVIEW_OUT = Path("pipeline/ocr_review.json")
REVIEW_IMAGES_DIR = Path("review")  # kalıcı, admin sayfasının okuyacağı klasör

CODE_RE = re.compile(r"\b\d{6,8}\b")         # 6-8 haneli bağımsız kod (format yıllar içinde değişmiş olabilir)
PRICE_RE = re.compile(r"\b(\d{1,4})\s?[t₺]\b", re.IGNORECASE)

# OCR çıktısında isimden ayıklanacak marketing/gürültü kelimeleri
NOISE_PATTERNS = [
    r"peşin\s*fiyat", r"taksit", r"adet", r"stok", r"garanti",
    r"kart\s*ile", r"nakit", r"^\d+\s*(yil|yıl)$",
]
NOISE_RE = re.compile("|".join(NOISE_PATTERNS), re.IGNORECASE)

# Broşürlerde ürün adının ALTINDA madde işaretli özellik/detay satırları oluyor
# ("• M,L,XL", "• %95 pamuk %5 elastan", "* 360 derece dönebilen..."). Bunlar
# isim için gürültü — sadece kalın/ana başlığı istiyoruz. OCR bu işaretleri
# •, *, «, » gibi farklı karakterlere okuyabiliyor; hangisi olursa olsun
# İLK görüldüğü yerde ismi kesip duruyoruz (o satırdaki öncesi varsa alınır,
# sonraki TÜM satırlar -varsa başka bir ürünün sızıntısı bile olsa- atılır).
BULLET_RE = re.compile(r"[•*·»«]")
# Kod bazen ismin/satırın başına sızıyor ("1641010 | o 164 Yuvarlak Cırt Bant...")
LEADING_CODE_RE = re.compile(r"^\s*\d{6,8}\s*[|:\-–—]?\s*(o\s+\d+\s+)?", re.IGNORECASE)


def clean_name(lines, code_line_idx, code_span, price_line_idx):
    """Kod ve fiyat gürültüsünü ayıklar, ilk madde işaretinde ismi keser."""
    name_lines = []
    for i, line in enumerate(lines):
        if i == price_line_idx:
            continue

        stripped = line.strip()
        if i == code_line_idx and code_span is not None:
            # Satırın tamamını atmak yerine SADECE kod kısmını çıkar —
            # kod bazen isimle aynı satırda oluyor, o zaman isim de kaybolmasın.
            stripped = (line[: code_span[0]] + line[code_span[1] :]).strip(" |:-–—.")

        if not stripped:
            continue
        if NOISE_RE.search(stripped):
            continue
        if re.fullmatch(r"[\d\W]+", stripped):  # sadece sayı/sembol olan satırları at
            continue

        m = BULLET_RE.search(stripped)
        if m:
            before = stripped[: m.start()].strip(" -:|.")
            if before:
                name_lines.append(before)
            break  # bu noktadan sonrası özellik/detay (ya da başka ürün sızıntısı) -> dur

        name_lines.append(stripped)

    name = " ".join(name_lines).strip()
    name = LEADING_CODE_RE.sub("", name).strip()
    name = re.sub(r"\s{2,}", " ", name)
    return name


def parse_ocr_text(raw_text):
    lines = [l for l in raw_text.split("\n") if l.strip()]

    # Kod genelde kartın EN ALTINDA duruyor -> tüm eşleşmeleri toplayıp SONUNCUSUNU al.
    # (Boşlukları silmiyoruz: "ij 1713165" gibi durumlarda \b sınırını bozup
    #  gerçek kodu kaçırmamak için orijinal satır üzerinde arıyoruz.)
    code, code_idx, code_span = None, None, None
    for i, line in enumerate(lines):
        m = CODE_RE.search(line)
        if m:
            code, code_idx, code_span = m.group(0), i, m.span()  # break YOK, son bulunan kalır

    price, price_idx = None, None
    for i, line in enumerate(lines):
        m = PRICE_RE.search(line)
        if m:
            price, price_idx = m.group(1), i
            break

    name = clean_name(lines, code_idx, code_span, price_idx)
    return code, name, price


def main():
    detections = json.loads(DETECTIONS_FILE.read_text()) if DETECTIONS_FILE.exists() else []
    if not detections:
        print("OCR için yeni crop yok.")
        OCR_OUT.write_text(json.dumps([]))
        return

    results, review_queue = [], []
    total = len(detections)
    print(f"OCR başlıyor: {total} ürün karesi işlenecek")

    for i, det in enumerate(detections, 1):
        if i % 25 == 0 or i == total:
            print(f"  ilerleme: {i}/{total}")
        img = Image.open(det["full_crop"])
        raw_text = pytesseract.image_to_string(img, lang="tur")
        code, name, price = parse_ocr_text(raw_text)

        record = {**det, "code": code, "name": name, "price": price, "raw_ocr": raw_text}

        if not code or not name:
            # pipeline/crops_full/... geçici (Actions diskinde), admin sayfası
            # görseli görebilsin diye kalıcı review/ klasörüne kopyalıyoruz.
            REVIEW_IMAGES_DIR.mkdir(exist_ok=True)
            content_hash = hashlib.md5(Path(det["full_crop"]).read_bytes()).hexdigest()[:16]
            review_filename = f"{content_hash}.jpg"
            shutil.copy(det["full_crop"], REVIEW_IMAGES_DIR / review_filename)
            record["review_image"] = f"review/{review_filename}"
            review_queue.append(record)
        else:
            results.append(record)

    OCR_OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2))

    existing_review = json.loads(REVIEW_OUT.read_text()) if REVIEW_OUT.exists() else []
    REVIEW_OUT.write_text(json.dumps(existing_review + review_queue, ensure_ascii=False, indent=2))

    print(f"OCR başarılı: {len(results)} | Elle bakılacak: {len(review_queue)}")


if __name__ == "__main__":
    main()
