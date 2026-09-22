"""
BİMKOD Pipeline — Adım 2: Ürün tespiti (YOLOv8)
Roboflow'da eğitilmiş modeli kullanır. Model, afiş üzerindeki her ürün
"karesini" (fotoğraf + isim + fiyat + kod hepsi birlikte) tek kutu olarak
tespit ediyor. Bu tam kare (full_crop) hem OCR'a hem CLIP embedding'e hem
de uygulamada gösterilecek thumbnail'e kaynak olarak kullanılıyor.

NOT: Daha önce "sadece fotoğraf" (üstten sabit bir oran) ayrı bir kırpım
üretiliyordu, ama farklı afiş şablonlarında bu oran fotoğrafın TAMAMINI
silip sadece metni bıraktığı için (gerçek örnekte görüldü — "Soda Plus"
ürününde hiç fotoğraf kalmamıştı, görsel arama bu yüzden başarısız oldu)
bu yaklaşımdan vazgeçildi. Tam kare daha güvenilir: en azından fotoğraf
her zaman içeride kalıyor, isim/fiyat/kod da görünür kalması kötü değil.
"""

import json
from pathlib import Path

from ultralytics import YOLO
from PIL import Image

MODEL_PATH = Path("pipeline/model/best.pt")
NEW_FILES = Path("pipeline/new_files.json")
FULL_CROPS_DIR = Path("pipeline/crops_full")
DETECTIONS_OUT = Path("pipeline/detections.json")

CONF_THRESHOLD = 0.4

# ---- Kutu payı (padding) ----
# DENENDİ VE GERİ ALINDI: %35 üst pay bazı ürünlerde fotoğrafı yakalasa da,
# çoğu üründe komşu (üstteki) ürünün fotoğrafını/metnini de kutuya dahil
# etti -> hem görselde iki ürün üst üste bindi hem de OCR iki ürünün metnini
# karıştırıp "Brode Perde -140x260 cm Terlik 163058 ... Ruletleri..." gibi
# anlamsız isimler üretti (ve bunlar bazen YANLIŞLIKLA "başarılı" sayılıp
# yayına bile girdi). Zarar faydadan büyük oldu, bu yüzden payı minimuma
# indiriyoruz (sadece metnin tam kenardan kırpılmasını önleyecek kadar).
# Asıl kalıcı çözüm: Roboflow etiketlerini tutarlı hale getirip modeli
# yeniden eğitmek. Münferit kötü kesimler için admin.html'deki "Canlı
# Ürünlerde Ara -> Sil ve Yeniden Tara" ile manuel kırpma aracı kullanılmalı.
PAD_TOP_RATIO = 0.0
PAD_SIDE_RATIO = 0.02
PAD_BOTTOM_RATIO = 0.02


def pad_box(x1, y1, x2, y2, img_w, img_h):
    w, h = x2 - x1, y2 - y1
    x1p = max(0, x1 - int(w * PAD_SIDE_RATIO))
    x2p = min(img_w, x2 + int(w * PAD_SIDE_RATIO))
    y1p = max(0, y1 - int(h * PAD_TOP_RATIO))
    y2p = min(img_h, y2 + int(h * PAD_BOTTOM_RATIO))
    return x1p, y1p, x2p, y2p


def main():
    FULL_CROPS_DIR.mkdir(parents=True, exist_ok=True)

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
            x1, y1, x2, y2 = pad_box(x1, y1, x2, y2, img.width, img.height)
            full_crop = img.crop((x1, y1, x2, y2))

            full_name = f"{crop_idx:06d}.jpg"
            full_crop.save(FULL_CROPS_DIR / full_name, quality=90)

            detections.append({
                "full_crop": str(FULL_CROPS_DIR / full_name),
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
