"""
BİMKOD Pipeline — Afiş (flyer) SATIŞ TARİHİ çıkarma

Afişlerin sol üst turuncu bandında ("SALI / 16 Haziran'dan itibaren") ve alt satırında
("Ürünler 16 Haziran tarihinden itibaren satışa sunulur") o afişteki ürünlerin satışa çıktığı
tarih yazıyor (ya da "26.10.2025" gibi sayısal biçimde). Bu tarih Telegram'da paylaşıldığı günden farklı
olabilir (ör. Cuma'nın ürünleri bir gün önceden paylaşılır), bu yüzden mesaj
tarihine güvenmek yerine tarihi afişin üzerinden OCR ile okuyoruz.

Çıktı: data/flyer_dates.json   ->   {"1212": "2026-10-09", "1213": "", ...}
  - anahtar: Telegram mesaj ID'si (products.json'daki sourceFlyer = raw_flyers/{ID}.jpg)
  - değer  : "YYYY-MM-DD" ya da "" (denendi ama tarih bulunamadı)
Site bu dosyayı okuyup ürün kartlarında gösterir. products.json'a DOKUNMAZ
(otomatik tarama commit'leriyle çakışma çıkmasın diye).

Kullanım:
  python pipeline/flyer_dates.py --new
      Bu çalışmada indirilen yeni afişleri (pipeline/new_files.json) işler.
      Günlük workflow'da, Telegram adımından hemen sonra çalışır.

  python pipeline/flyer_dates.py --backfill [--limit 200] [--retry-empty]
      Eski afişleri (products.json'da geçen ama flyer_dates.json'da olmayan)
      Telegram'dan mesaj ID'siyle tekrar indirip tarihini okur. TELEGRAM_*
      secret'ları gerekir. Her çalışmada en fazla --limit afiş işler; bitene
      kadar workflow'u tekrar çalıştırın.

  python pipeline/flyer_dates.py --test dosya.jpg [YYYY-MM-DD]
      Tek bir görselde dene (tarih ikinci argümanla verilen paylaşım gününe
      göre doğrulanır). OCR ayarını denemek için.
"""

import argparse
import difflib
import json
import os
import re
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

DATES_FILE = Path("data/flyer_dates.json")
NEW_FILES = Path("pipeline/new_files.json")
PRODUCTS_FILE = Path("data/products.json")
CHANNEL = "kisakod"

# Geçerli aralık: satış tarihi, paylaşım gününden en fazla 3 gün ÖNCE ya da 21 gün SONRA olabilir.
WINDOW_BEFORE_DAYS = 3
WINDOW_AFTER_DAYS = 21

# Türkçe harfleri sadeleştirip karşılaştırıyoruz (tesseract'ın "eng" modeli ş,ğ,ı vb.
# harfleri zaten bozuk okur; Türkçe dil paketi olmasa da çalışsın diye).
_FOLD = str.maketrans("çğıöşüÇĞİÖŞÜI", "cgiosucgiosui")
MONTH_NAMES = {
    "ocak": 1, "subat": 2, "mart": 3, "nisan": 4, "mayis": 5, "haziran": 6,
    "temmuz": 7, "agustos": 8, "eylul": 9, "ekim": 10, "kasim": 11, "aralik": 12,
}
WEEKDAYS = {  # Monday=0 ... Sunday=6 (datetime.weekday ile aynı)
    "pazartesi": 0, "sali": 1, "carsamba": 2, "persembe": 3, "cuma": 4, "cumartesi": 5, "pazar": 6,
}

# Afişlerdeki gerçek biçimler:
#   sol üst bant : "SALI" + "16 Haziran'dan itibaren"   (gün adı + gün + ay, YIL YOK)
#   alt satır    : "Ürünler 16 Haziran tarihinden itibaren satışa sunulur" ... "HAZİRAN 2026"
#   (ayrıca) "26.10.2025" gibi sayısal biçim
NUM_RE = re.compile(r"(?<!\d)(\d{1,2})\s*[./\-]\s*(\d{1,2})\s*[./\-]\s*(20\d{2}|\d{2})(?!\d)")
TXT_RE = re.compile(r"(?<!\d)(\d{1,2})\s*([a-z]{3,10})(?:\s+(20\d{2}))?")


def fold(s):
    s = s.translate(_FOLD).lower().replace("\u0307", "")
    return s


def _match(word, table, cutoff=0.8):
    """OCR hatalarına dayanıklı sözcük eşleme ("Hazlran" -> haziran)."""
    word = re.sub(r"[^a-z]", "", word)
    if len(word) < 3:
        return None
    if word in table:
        return table[word]
    if len(word) < 4:
        return None
    m = difflib.get_close_matches(word, list(table), n=1, cutoff=cutoff)
    return table[m[0]] if m else None


def find_weekdays(text):
    """Metindeki gün adları (SALI, CUMA...) -> {weekday numarası}. Doğrulama için kullanılır."""
    out = set()
    for w in re.findall(r"[a-z]{3,}", fold(text)):
        v = _match(w, WEEKDAYS, cutoff=0.85)
        if v is not None:
            out.add(v)
    return out


# ---------------------------------------------------------------- metinden tarih
def parse_dates(text, ref, year_hint=None):
    """OCR metninden tarih adaylarını (datetime.date) çıkarır. ref: paylaşım günü (yıl tahmini için)."""
    found = []
    t = text.replace("O", "0").replace("o", "0") if re.search(r"\d", text) else text
    for m in NUM_RE.finditer(t):
        d, mo, y = int(m.group(1)), int(m.group(2)), m.group(3)
        y = int(y) + 2000 if len(y) == 2 else int(y)
        try:
            found.append(date(y, mo, d))
        except ValueError:
            pass
    for m in TXT_RE.finditer(fold(text)):
        d = int(m.group(1))
        mo = _match(m.group(2), MONTH_NAMES)
        if not mo:
            continue
        years = ([int(m.group(3))] if m.group(3)
                 else [year_hint] if year_hint
                 else [ref.year - 1, ref.year, ref.year + 1])
        for y in years:
            try:
                found.append(date(y, mo, d))
            except ValueError:
                pass
    return found


def pick_valid(cands, post, weekdays=None):
    """Pencere içindeki adaylardan seç. Aynı metinde gün adı (SALI...) da okunduysa tarihin
    haftanın günü onunla UYUŞMALI; uyuşmuyorsa OCR hatası sayılıp reddedilir (yanlış tarih
    göstermektense hiç göstermemek tercih edilir). Birden fazla aday kalırsa en erkeni."""
    lo = post - timedelta(days=WINDOW_BEFORE_DAYS)
    hi = post + timedelta(days=WINDOW_AFTER_DAYS)
    ok = sorted({c for c in cands if lo <= c <= hi})
    if weekdays:
        ok = [c for c in ok if c.weekday() in weekdays]
    return ok[0] if ok else None


# ---------------------------------------------------------------- görselden OCR
def _regions(img):
    """(isim, kırpım, psm listesi). Tarih HER ZAMAN sol üst turuncu bantta ("SALI / 16 Haziran'dan
    itibaren") ve alt satırda ("... 16 Haziran tarihinden itibaren satışa sunulur") bulunur; önce
    onlara bakılır. Sonra yedek olarak köşeler/kenarlar (sayısal tarih biçimi için)."""
    w, h = img.size
    out = []
    out.append(("sol-üst-bant", img.crop((0, 0, int(w * 0.42), int(h * 0.12))), ("6", "11")))
    out.append(("sol-üst-geniş", img.crop((0, 0, int(w * 0.50), int(h * 0.16))), ("11", "6")))
    out.append(("alt-satır", img.crop((0, int(h * 0.955), int(w * 0.62), h)), ("6", "11")))
    out.append(("alt-şerit", img.crop((0, int(h * 0.92), w, h)), ("6",)))
    cw, ch = int(w * 0.34), int(h * 0.10)
    out.append(("alt-sağ", img.crop((w - cw, h - ch, w, h)), ("6",)))
    out.append(("üst-sağ", img.crop((w - cw, 0, w, ch)), ("6",)))
    out.append(("üst", img.crop((0, 0, w, int(h * 0.08))), ("6",)))
    sw = int(w * 0.07)
    for name, box in (("sol", (0, 0, sw, h)), ("sağ", (w - sw, 0, w, h))):
        strip = img.crop(box)
        out.append((name + "-90", strip.rotate(90, expand=True), ("6",)))
        out.append((name + "+90", strip.rotate(-90, expand=True), ("6",)))
    return out


def read_month_year(img):
    """Sağ alttaki "HAZİRAN 2026" ibaresinden (ay, yıl) okur. Gün sol üst bantta, ay ve YIL
    sağ altta yazıyor; yılı buradan almak, gün+ay'dan tarihi paylaşım gününe bakmadan
    kurmamızı sağlar. Okunamazsa (None, None)."""
    import pytesseract
    w, h = img.size
    for box in ((int(w * 0.55), int(h * 0.95), w, h), (int(w * 0.45), int(h * 0.93), w, h)):
        crop = img.crop(box)
        for invert in (False, True):
            for psm in ("6", "11"):
                try:
                    text = pytesseract.image_to_string(_prep(crop, invert), lang="eng", config=f"--psm {psm}")
                except Exception:
                    continue
                for m in re.finditer(r"([a-z]{4,9})\s*[-./]?\s*(20\d{2})", fold(text)):
                    mo = _match(m.group(1), MONTH_NAMES)
                    if mo:
                        return mo, int(m.group(2))
    return None, None


def _prep(crop, invert=False):
    from PIL import ImageOps
    g = ImageOps.grayscale(crop)
    w, h = g.size
    scale = 3 if max(w, h) < 1500 else 2
    g = g.resize((w * scale, h * scale))
    g = ImageOps.autocontrast(g)
    return ImageOps.invert(g) if invert else g


def ocr_sale_date(path, post):
    """Afiş görselinden satış tarihini okur. Dönüş: (date | None, bulunduğu bölge)."""
    import pytesseract
    from PIL import Image

    img = Image.open(path).convert("RGB")
    seen_weekdays = set()
    hint_month, hint_year = read_month_year(img)  # sağ alt: "HAZİRAN 2026"
    for name, crop, psms in _regions(img):
        for invert in (False, True):
            prepped = _prep(crop, invert)
            for psm in psms:
                try:
                    text = pytesseract.image_to_string(prepped, lang="eng", config=f"--psm {psm}")
                except Exception:
                    continue
                if not re.search(r"\d", text):
                    continue
                days = find_weekdays(text)
                seen_weekdays |= days
                d = pick_valid(parse_dates(text, post, hint_year), post, days)
                if not d and hint_year:  # ipucu yanlış okunduysa yıl tahminine geri dön
                    d = pick_valid(parse_dates(text, post), post, days)
                if d:
                    return d, name
    # Son çare: tüm görsel, seyrek metin modu (yazı büyükse yakalar)
    try:
        small = img.copy()
        small.thumbnail((2400, 2400))
        text = pytesseract.image_to_string(_prep(small), lang="eng", config="--psm 11")
        d = pick_valid(parse_dates(text, post), post, find_weekdays(text) or seen_weekdays)
        if d:
            return d, "tüm-görsel"
    except Exception:
        pass
    return None, None


# ---------------------------------------------------------------- dosya yönetimi
def load_dates():
    if DATES_FILE.exists():
        try:
            return json.loads(DATES_FILE.read_text(encoding="utf-8"))
        except ValueError:
            return {}
    return {}


def save_dates(d):
    DATES_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATES_FILE.write_text(json.dumps(d, ensure_ascii=False, sort_keys=True), encoding="utf-8")


def parse_iso_date(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def run_new():
    files = json.loads(NEW_FILES.read_text()) if NEW_FILES.exists() else []
    dates = load_dates()
    n_ok = 0
    for e in files:
        path = e["path"] if isinstance(e, dict) else e
        msg_id = Path(path).stem
        post = parse_iso_date(e.get("date")) if isinstance(e, dict) else None
        post = post or date.today()
        d, where = ocr_sale_date(path, post)
        dates[msg_id] = d.isoformat() if d else ""
        n_ok += 1 if d else 0
        print(f"  {msg_id}: {dates[msg_id] or 'tarih bulunamadı'} ({where or '-'})")
    save_dates(dates)
    print(f"Afiş tarihi: {n_ok}/{len(files)} okundu.")


def run_test(path, post_str):
    post = date.fromisoformat(post_str) if post_str else date.today()
    d, where = ocr_sale_date(path, post)
    print(f"sonuç: {d} (bölge: {where}) | paylaşım günü: {post}")


def run_backfill(limit, retry_empty):
    import asyncio
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    api_id = int(os.environ["TELEGRAM_API_ID"])
    api_hash = os.environ["TELEGRAM_API_HASH"]
    session = os.environ["TELEGRAM_SESSION"]

    products = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
    ids = sorted({int(Path(p["sourceFlyer"]).stem) for p in products if p.get("sourceFlyer")}, reverse=True)
    dates = load_dates()
    todo = [i for i in ids if str(i) not in dates or (retry_empty and dates.get(str(i)) == "")]
    print(f"Toplam afiş: {len(ids)} | tarihi olmayan: {len(todo)} | bu çalışmada: {min(limit, len(todo))}")
    todo = todo[:limit]

    async def go():
        done = ok = 0
        async with TelegramClient(StringSession(session), api_id, api_hash) as client:
            entity = await client.get_entity(CHANNEL)
            with tempfile.TemporaryDirectory() as tmp:
                for k in range(0, len(todo), 50):
                    batch = todo[k:k + 50]
                    msgs = await client.get_messages(entity, ids=batch)
                    for mid, msg in zip(batch, msgs):
                        if msg is None or (not msg.photo and not msg.document):
                            dates[str(mid)] = ""  # mesaj silinmiş
                            continue
                        f = Path(tmp) / f"{mid}.jpg"
                        await client.download_media(msg, file=str(f))
                        post = msg.date.date() if msg.date else date.today()
                        d, where = ocr_sale_date(f, post)
                        dates[str(mid)] = d.isoformat() if d else ""
                        ok += 1 if d else 0
                        done += 1
                        f.unlink(missing_ok=True)
                        print(f"  {mid}: {dates[str(mid)] or 'tarih bulunamadı'} ({where or '-'})")
                    save_dates(dates)  # her 50'de bir kaydet (yarıda kesilirse kaybolmasın)
        print(f"Bitti: {ok}/{done} afişte tarih okundu.")

    asyncio.run(go())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--retry-empty", action="store_true")
    ap.add_argument("--test", nargs="+")
    a = ap.parse_args()
    if a.test:
        run_test(a.test[0], a.test[1] if len(a.test) > 1 else None)
    elif a.new:
        run_new()
    elif a.backfill:
        run_backfill(a.limit, a.retry_empty)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
