"""
BİMKOD Pipeline — Adım 4: CLIP embedding
ocr_extract.py'ın kod+isim atadığı ürünlerin "full_crop" (tam kare) görseli
üzerinden embedding çıkarır. openai/clip-vit-base-patch32 kullanılır —
tarayıcıdaki Xenova/clip-vit-base-patch32 (Transformers.js) ile AYNI
ağırlıkların ONNX'e çevrilmiş hali olduğu için embedding uzayı birebir
uyumludur.
"""

import json
from pathlib import Path

import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

OCR_RESULTS = Path("pipeline/ocr_results.json")
EMBED_OUT = Path("pipeline/new_embeddings.json")

MODEL_NAME = "openai/clip-vit-base-patch32"


def main():
    items = json.loads(OCR_RESULTS.read_text()) if OCR_RESULTS.exists() else []
    if not items:
        print("Embedding üretilecek yeni ürün yok.")
        EMBED_OUT.write_text(json.dumps([]))
        return

    model = CLIPModel.from_pretrained(MODEL_NAME)
    processor = CLIPProcessor.from_pretrained(MODEL_NAME)
    model.eval()

    results = []
    with torch.no_grad():
        for item in items:
            img = Image.open(item["full_crop"]).convert("RGB")
            inputs = processor(images=img, return_tensors="pt")
            feats = model.get_image_features(**inputs)
            feats = feats / feats.norm(p=2, dim=-1, keepdim=True)  # L2 normalize

            results.append({
                "full_crop": item["full_crop"],
                "code": item["code"],
                "name": item["name"],
                "price": item.get("price"),
                "flyer_date": item.get("flyer_date"),
                "confidence": item["confidence"],
                "embedding": feats[0].tolist(),
            })

    EMBED_OUT.write_text(json.dumps(results, ensure_ascii=False))
    print(f"Embedding üretildi: {len(results)} ürün")


if __name__ == "__main__":
    main()
