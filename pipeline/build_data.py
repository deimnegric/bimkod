"""
BİMKOD Pipeline — Adım 5: Veri birleştirme
new_embeddings.json içindeki (OCR ile kod/isim/fiyat atanmış) her ürünü
data/products.json + data/embeddings.json'a ekler.

Kod bazlı DEDUPE: aynı kod (örn. bir ürün bu hafta tekrar afişe çıktıysa)
zaten varsa -> mevcut kaydı GÜNCELLER (yeni fiyat/foto/addedAt), yeni satır
EKLEMEZ. embIndex sabit kalır, sadece embeddings.json'daki ilgili vektör
üzerine yazılır.

Elle düzeltme: pipeline/catalog_source/corrections.csv varsa (code,name
sütunları) OCR'ın yanlış okuduğu isimleri bununla ezer — OCR hatalarını
kalıcı düzeltmenin en hızlı yolu, kod her zaman aynı format olduğu için
tekrar tekrar aynı hatayı düzeltmeye gerek kalmaz.
"""

import csv
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

NEW_EMB_FILE = Path("pipeline/new_embeddings.json")
PRODUCTS_FILE = Path("data/products.json")
EMBEDDINGS_FILE = Path("data/embeddings.json")
CORRECTIONS_FILE = Path("pipeline/catalog_source/corrections.csv")
IMAGES_DIR = Path("images")


def load_corrections():
    if not CORRECTIONS_FILE.exists():
        return {}
    with open(CORRECTIONS_FILE, newline="", encoding="utf-8") as f:
        return {row["code"]: row["name"] for row in csv.DictReader(f)}


def main():
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    new_items = json.loads(NEW_EMB_FILE.read_text()) if NEW_EMB_FILE.exists() else []
    if not new_items:
        print("Eklenecek yeni ürün yok.")
        return

    corrections = load_corrections()

    products = json.loads(PRODUCTS_FILE.read_text()) if PRODUCTS_FILE.exists() else []
    emb_data = json.loads(EMBEDDINGS_FILE.read_text()) if EMBEDDINGS_FILE.exists() else {
        "model": "Xenova/clip-vit-base-patch32", "dim": 512, "vectors": []
    }
    by_code = {p["code"]: p for p in products}

    now_iso = datetime.now(timezone.utc).isoformat()
    added, updated = 0, 0

    for item in new_items:
        code = item["code"]
        name = corrections.get(code, item["name"])
        added_at = item.get("flyer_date") or now_iso

        existing = by_code.get(code)
        if existing:
            emb_index = existing["embIndex"]
        else:
            emb_index = len(emb_data["vectors"])
            emb_data["vectors"].append(None)  # yer tutucu, aşağıda dolduruluyor

        final_name = f"{emb_index:06d}.jpg"
        final_path = IMAGES_DIR / final_name
        src = Path(item["photo_crop"])
        if src.exists():
            shutil.copy(src, final_path)

        emb_data["vectors"][emb_index] = item["embedding"]

        record = {
            "code": code,
            "name": name,
            "price": item.get("price"),
            "image": f"images/{final_name}",
            "embIndex": emb_index,
            "confidence": item["confidence"],
            "addedAt": added_at,
        }

        if existing:
            existing.update(record)
            updated += 1
        else:
            products.append(record)
            by_code[code] = record
            added += 1

    PRODUCTS_FILE.write_text(json.dumps(products, ensure_ascii=False, indent=2))
    EMBEDDINGS_FILE.write_text(json.dumps(emb_data))

    print(f"Yeni eklenen: {added} | Güncellenen: {updated} | Toplam: {len(products)}")


if __name__ == "__main__":
    main()
