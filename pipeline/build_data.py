"""
BİMKOD Pipeline — Adım 5: Veri birleştirme
new_embeddings.json içindeki (OCR ile kod/isim/fiyat atanmış) her ürünü
data/products.json + data/embeddings.bin'e ekler.

*** ÖNEMLİ: embedding depolama formatı değişti ***
Embedding'ler artık data/embeddings.json (metin/JSON) içinde DEĞİL,
data/embeddings.bin adlı HAM BINARY dosyada tutuluyor (float32, art arda,
her biri 512 sayı). data/embeddings.json artık sadece küçük bir metadata
dosyası: {"model", "dim", "count"}. Sebep: JSON metin olarak 5000+ üründe
dosya 61MB'a çıkmıştı — hem her site ziyaretinde indirilen veri boyutunu
hem admin sayfasının GitHub API ile okuma/yazmasını imkansız hale
getiriyordu (GitHub API 1MB üstü dosyalarda içeriği JSON içinde döndürmüyor).
Binary format aynı veriyi ~5.5 kat daha küçük tutar ve JSON parse etmeye
gerek kalmaz.

Kod bazlı DEDUPE: aynı kod (örn. bir ürün bu hafta tekrar afişe çıktıysa)
zaten varsa -> mevcut kaydı GÜNCELLER (yeni fiyat/foto/addedAt), yeni satır
EKLEMEZ. embIndex sabit kalır, sadece o index'teki binary satır üzerine
yazılır.

Elle düzeltme: pipeline/catalog_source/corrections.csv varsa (code,name
sütunları) OCR'ın yanlış okuduğu isimleri bununla ezer.
"""

import csv
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

NEW_EMB_FILE = Path("pipeline/new_embeddings.json")
PRODUCTS_FILE = Path("data/products.json")
EMBEDDINGS_META_FILE = Path("data/embeddings.json")
EMBEDDINGS_BIN_FILE = Path("data/embeddings.bin")
CORRECTIONS_FILE = Path("pipeline/catalog_source/corrections.csv")
IMAGES_DIR = Path("images")
DIM = 512
MODEL_NAME = "Xenova/clip-vit-base-patch32"


def load_embeddings():
    """.bin dosyasından float32 matris olarak yükler (yoksa boş matris döner)."""
    if EMBEDDINGS_BIN_FILE.exists():
        flat = np.fromfile(EMBEDDINGS_BIN_FILE, dtype=np.float32)
        return flat.reshape(-1, DIM) if flat.size else np.zeros((0, DIM), dtype=np.float32)
    return np.zeros((0, DIM), dtype=np.float32)


def save_embeddings(matrix):
    matrix.astype(np.float32).tofile(EMBEDDINGS_BIN_FILE)
    EMBEDDINGS_META_FILE.write_text(json.dumps({
        "model": MODEL_NAME, "dim": DIM, "count": int(matrix.shape[0]),
    }))


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
    emb_matrix = load_embeddings()
    by_code = {p["code"]: p for p in products}

    now_iso = datetime.now(timezone.utc).isoformat()
    added, updated = 0, 0
    new_rows = []  # sadece gerçekten yeni ürünler için ek satırlar, sona toplu eklenecek

    for item in new_items:
        code = item["code"]
        name = corrections.get(code, item["name"])
        added_at = item.get("flyer_date") or now_iso
        vec = np.array(item["embedding"], dtype=np.float32)

        existing = by_code.get(code)
        if existing:
            emb_index = existing["embIndex"]
            if emb_index < emb_matrix.shape[0]:
                emb_matrix[emb_index] = vec  # mevcut satırın üzerine yaz
        else:
            emb_index = emb_matrix.shape[0] + len(new_rows)
            new_rows.append(vec)

        final_name = f"{emb_index:06d}.jpg"
        final_path = IMAGES_DIR / final_name
        src = Path(item["full_crop"])
        if src.exists():
            shutil.copy(src, final_path)

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

    if new_rows:
        emb_matrix = np.vstack([emb_matrix, np.array(new_rows, dtype=np.float32)])

    PRODUCTS_FILE.write_text(json.dumps(products, ensure_ascii=False, indent=2))
    save_embeddings(emb_matrix)

    print(f"Yeni eklenen: {added} | Güncellenen: {updated} | Toplam: {len(products)}")
    print(f"embeddings.bin boyutu: {EMBEDDINGS_BIN_FILE.stat().st_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
