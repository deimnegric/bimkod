"""
BİMKOD Pipeline — Adım 2: Ürün tespiti (YOLOv8)
Roboflow'da eğitilmiş modeli kullanır (~90% mAP). Model, afiş üzerindeki her
ürün "karesini" (fotoğraf + isim + fiyat + kod hepsi birlikte, bkz. örnek
crop) tek kutu olarak tespit ediyor.

Her tespit için İKİ görsel üretilir:
  - full  (tam kare): isim/fiyat/kod metnini de içerir -> OCR bunu okuyacak
  - photo (sadece üst kısım): metin olmadan temiz ürün fotoğrafı ->
    uygulamada gösterilecek thumbnail + CLIP embedding bunun üzerinden

PHOTO_HEIGHT_RATIO: karenin üstten yüzde kaçı "sadece fotoğraf" sayılsın.
Gerçek crop'lara bakıp bu oranı ayarlamak gerekebilir (örnek karede ~%55-60
civarı fotoğraf, altında isim + fiyat + kod var).
"""

import json
from pathlib import Path

from ultralytics import YOLO
from PIL import Image

MODEL_PATH = Path("pipeline/model/best.pt")
NEW_FILES = Path("pipeline/new_files.json")
FULL_CROPS_DIR = Path("pipeline/crops_full")
PHOTO_CROPS_DIR = Path("pipeline/crops_photo")
DETECTIONS_OUT = Path("pipeline/detections.json")

CONF_THRESHOLD = 0.4
PHOTO_HEIGHT_RATIO = 0.58  # TODO: gerçek crop'larla kalibre et


def main():
    FULL_CROPS_DIR.mkdir(parents=True, exist_ok=True)
    PHOTO_CROPS_DIR.mkdir(parents=True, exist_ok=True)

    new_files = json.loads(NEW_FILES.read_text()) if NEW_FILES.exists() else []
    if not new_files:
        print("Yeni dosya yok, tespit atlanıyor.")
        DETECTIONS_OUT.write_text(json.dumps([]))
        return

    model = YOLO(str(MODEL_PATH))
    detections = []
    crop_idx = 0

    for entry in new_files:
        fpath = entry["path"] if isinstance(entry, dict) else entry
        flyer_date = entry.get("date") if isinstance(entry, dict) else None

        img = Image.open(fpath).convert("RGB")
        results = model.predict(img, conf=CONF_THRESHOLD, verbose=False)[0]

        for box in results.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
            full_crop = img.crop((x1, y1, x2, y2))

            photo_h = int((y2 - y1) * PHOTO_HEIGHT_RATIO)
            photo_crop = full_crop.crop((0, 0, full_crop.width, photo_h))

            full_name = f"{crop_idx:06d}.jpg"
            photo_name = f"{crop_idx:06d}.jpg"
            full_crop.save(FULL_CROPS_DIR / full_name, quality=90)
            photo_crop.save(PHOTO_CROPS_DIR / photo_name, quality=90)

            detections.append({
                "full_crop": str(FULL_CROPS_DIR / full_name),
                "photo_crop": str(PHOTO_CROPS_DIR / photo_name),
                "source_flyer": fpath,
                "flyer_date": flyer_date,
                "bbox": [x1, y1, x2, y2],
                "confidence": float(box.conf[0]),
            })
            crop_idx += 1

    DETECTIONS_OUT.write_text(json.dumps(detections, ensure_ascii=False, indent=2))
    print(f"Tespit edilen ürün sayısı: {len(detections)}")


if __name__ == "__main__":
    main()
