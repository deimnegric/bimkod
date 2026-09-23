"""
BİMKOD Pipeline — Adım 3: OCR ile isim/kod/fiyat çıkarma
detect_products.py'ın ürettiği "full_crop" (foto+isim+fiyat+kod hepsi bir arada)
üzerinde OCR çalıştırır ve şu alanları ayrıştırır:
  - code : 6-8 haneli ürün kodu (örn. 1646722) — konumu karta göre değişebiliyor
  - name : ürün adı — SADECE büyük/kalın BAŞLIK metni, küçük punto özellik/
           detay satırları (• Güç: 535 W, • %95 pamuk %5 elastan vb.) hariç
  - price: "349" gibi TL tutarı (best-effort, opsiyonel bilgi)

İsim çıkarma yazı BOYUTUNA bakarak yapılıyor (bullet/madde işareti aramak
yerine): Tesseract'ın image_to_data çıktısından her satırın piksel
yüksekliğini alıyoruz, en büyük yükseklikteki satır(lar)ı "başlık" kabul
edip küçük punto satırları atıyoruz. Bu, OCR bir madde işaretini yanlış/hiç
okuyamasa bile (küçük yazı genelde daha çok bozuluyor) çalışmaya devam eder.

Kod için ayrıca görselin TAMAMINI büyütüp (upscale) SADECE RAKAM izniyle
ikinci bir geçiş yapıyoruz; konumu karta göre değiştiği için sabit bir
şerit yerine tüm görseli tarıyoruz. Koyu zemin üzerine açık renkli
(beyaz-üstü-siyah rozet gibi) yazılarda Tesseract çok kötü performans
gösterdiği için, görsel karanlıksa OCR'a vermeden önce renkleri ters
çeviriyoruz (invert).

OCR mükemmel olmayacak (Türkçe karakterler, düşük çözünürlük vb.) — kod
YA DA isim çıkarılamayan crop'lar pipeline/ocr_review.json'a düşer, elle
düzeltme/onay için.
"""

import hashlib
import json
import re
import shutil
from pathlib import Path

import pytesseract
from pytesseract import Output
from PIL import Image, ImageOps

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

# Nadiren küçük punto satırda okunaklı bir madde işareti kalırsa (•,*,«,»)
# yine de orada kesiyoruz — ama artık ASIL filtre yazı boyutu.
BULLET_RE = re.compile(r"[•*·»«]")
# Kod bazen ismin/satırın başına sızıyor ("1641010 | o 164 Yuvarlak Cırt Bant...")
LEADING_CODE_RE = re.compile(r"^\s*\d{6,8}\s*[|:\-–—]?\s*(o\s+\d+\s+)?", re.IGNORECASE)

TITLE_HEIGHT_RATIO = 0.6  # bir satır, çıpa (ilk) satırın bu oranından KÜÇÜKSE "detay" sayılır


def is_mostly_numeric(text):
    """Fiyat/kod gibi rakam-ağırlıklı satırları (tam rakam olmasa bile,
    örn. OCR bir sembolü harfe çevirip '699t' gibi kaçırdıysa) tespit eder."""
    letters = sum(1 for c in text if c.isalpha())
    digits = sum(1 for c in text if c.isdigit())
    return digits > 0 and digits >= letters


def is_suspicious_name(name):
    """İsim teknik olarak 'bulundu' ama muhtemelen anlamsız/eksikse (örn.
    '(> Fakir' gibi bir logonun bozuk OCR'ı) — yayınlamak yerine admin'e
    (görseliyle birlikte) gönderip elle tamamlanmasını istiyoruz."""
    if not name:
        return True
    letters = sum(1 for c in name if c.isalpha())
    if letters < 3:
        return True
    first_alpha = next((c for c in name if c.isalnum()), "")
    if not first_alpha.isalpha():
        return True  # isim bir harfle değil garip bir sembolle/sayıyla başlıyor
    return False


def preprocess_for_ocr(img, scale=2):
    """Büyütme (upscale) + gri tonlama + koyu zeminse ters çevirme (invert).
    Küçük/düşük çözünürlüklü ya da koyu-rozet-beyaz-yazı kırpımlarında
    Tesseract'ın doğruluğunu belirgin artırıyor."""
    if scale != 1:
        img = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
    gray = ImageOps.grayscale(img)
    # Ortalama piksel karanlıksa (koyu zemin/açık yazı), Tesseract için ters çevir
    if gray.getextrema() != (0, 0):  # tamamen siyah/boş görsel değilse
        hist = gray.histogram()
        total = sum(hist)
        mean = sum(i * c for i, c in enumerate(hist)) / total if total else 255
        if mean < 110:
            gray = ImageOps.invert(gray)
    return gray


def _digit_scan(img):
    text = pytesseract.image_to_string(
        img, lang="tur", config="--psm 11 -c tessedit_char_whitelist=0123456789"
    )
    matches = CODE_RE.findall(text)
    return matches[-1] if matches else None


def extract_code_anywhere(img):
    """Kodun kart üzerindeki konumu tasarıma göre değişiyor (bazen altta,
    bazen ortada) -> sabit bir şerit yerine TÜM görseli, sadece rakam
    izniyle ikinci kez okuyoruz. Genel parlaklık ortalaması küçük/koyu bir
    rozeti (beyaz yazı) tetiklemeyebileceği için hem normal hem TERS
    ÇEVRİLMİŞ halde deniyoruz, hangisi bulursa onu kullanıyoruz."""
    processed = preprocess_for_ocr(img, scale=3)
    code = _digit_scan(processed)
    if code:
        return code
    return _digit_scan(ImageOps.invert(processed))


def get_ocr_lines(img, lang="tur"):
    """Tesseract'tan satır bazlı metin + o satırın ortalama piksel
    yüksekliğini (font boyutu göstergesi) döndürür, üstten alta sıralı."""
    data = pytesseract.image_to_data(img, lang=lang, output_type=Output.DICT)
    grouped = {}
    n = len(data["text"])
    for i in range(n):
        word = data["text"][i].strip()
        if not word:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        top, height = data["top"][i], data["height"][i]
        entry = grouped.setdefault(key, {"words": [], "top": top, "height_sum": 0.0, "n": 0})
        entry["words"].append(word)
        entry["height_sum"] += height
        entry["n"] += 1
        entry["top"] = min(entry["top"], top)
    ordered = sorted(grouped.values(), key=lambda l: l["top"])
    return [{"text": " ".join(l["words"]), "height": l["height_sum"] / l["n"]} for l in ordered]


def clean_name(ocr_lines, price_text):
    """Sadece BÜYÜK/KALIN başlık satırlarını isim olarak alır. Küçük punto
    özellik/detay satırlarını -okunaklı bir madde işareti olsun ya da OCR
    onu tamamen bozmuş olsun fark etmeksizin- yükseklik farkına bakarak eler."""
    candidates = []
    for line in ocr_lines:
        t = line["text"].strip()
        if not t or t == price_text:
            continue
        if NOISE_RE.search(t):
            continue
        if re.fullmatch(r"[\d\W]+", t):  # sadece sayı/sembol olan satırları at (kod, fiyat vb.)
            continue
        if is_mostly_numeric(t):  # örn. OCR "699₺"yi "699t" gibi kaçırmışsa da yakala
            continue
        candidates.append({"text": t, "height": line["height"]})

    if not candidates:
        return ""

    # Çıpa: global en büyük satır yerine İLK satırı baz alıyoruz. Bazı
    # tasarımlarda fiyat/logo başlıktan daha büyük punto olabiliyor; global
    # max kullanmak o durumda gerçek başlığı da eleyip boş isim üretiyordu.
    # İlk satır neredeyse hep başlığın kendisi (ya da onun bir parçası).
    threshold = candidates[0]["height"] * TITLE_HEIGHT_RATIO

    name_lines = []
    for c in candidates:
        if c["height"] < threshold:
            break  # küçük punto -> detay/özellik başladı, dur

        t = c["text"]
        m = CODE_RE.search(t)
        if m:  # kod bazen başlıkla aynı satırda -> sadece kodu çıkar
            t = (t[: m.start()] + t[m.end():]).strip(" |:-–—.")
        if not t:
            continue

        bm = BULLET_RE.search(t)
        if bm:
            before = t[: bm.start()].strip(" -:|.")
            if before:
                name_lines.append(before)
            break

        name_lines.append(t)

    name = " ".join(name_lines).strip()
    name = LEADING_CODE_RE.sub("", name).strip()
    # Baştaki anlamsız sembol çöplerini temizle (örn. logonun bozuk OCR'ından
    # kalan "(>", "©", "-" gibi karakterler) — ilk gerçek harfe kadar at.
    name = re.sub(r"^[^a-zA-ZÇĞİÖŞÜçğıöşü0-9]+", "", name)
    name = re.sub(r"[^a-zA-ZÇĞİÖŞÜçğıöşü0-9)\"'%]+$", "", name)
    name = re.sub(r"\s{2,}", " ", name)
    return name


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
        processed = preprocess_for_ocr(img, scale=2)

        ocr_lines = get_ocr_lines(processed)
        raw_text = "\n".join(l["text"] for l in ocr_lines)

        price, price_text = None, None
        for l in ocr_lines:
            m = PRICE_RE.search(l["text"])
            if m:
                price, price_text = m.group(1), l["text"]
                break

        name = clean_name(ocr_lines, price_text)
        code = extract_code_anywhere(img)

        record = {**det, "code": code, "name": name, "price": price, "raw_ocr": raw_text}

        if not code or not name or is_suspicious_name(name):
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
