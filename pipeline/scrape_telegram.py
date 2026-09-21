"""
BİMKOD Pipeline — Adım 1: Telegram arşiv çekme
kisakod kanalından yeni flyer görsellerini indirir.

Gerekli GitHub Secrets:
  TELEGRAM_API_ID
  TELEGRAM_API_HASH
  TELEGRAM_SESSION   (StringSession — bir kere lokalde login olup üretilir)

Lokalde session üretmek için (bir defalık, kendi bilgisayarında):
    python -c "
from telethon.sync import TelegramClient
from telethon.sessions import StringSession
with TelegramClient(StringSession(), API_ID, 'API_HASH') as c:
    print(c.session.save())
"
Çıkan string'i GitHub repo -> Settings -> Secrets -> Actions -> TELEGRAM_SESSION olarak ekle.
"""

import asyncio
import os
import json
from pathlib import Path

from telethon import TelegramClient
from telethon.sessions import StringSession

CHANNEL = "kisakod"
RAW_DIR = Path("pipeline/raw_flyers")
STATE_FILE = Path("pipeline/scrape_state.json")
RESCAN_QUEUE_FILE = Path("pipeline/rescan_queue.json")  # admin.html'in doldurduğu, min_id'den bağımsız yeniden çekilecek mesaj ID'leri

API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
SESSION = os.environ["TELEGRAM_SESSION"]


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"last_message_id": 0}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state))


def load_rescan_queue():
    if RESCAN_QUEUE_FILE.exists():
        try:
            return sorted(set(int(x) for x in json.loads(RESCAN_QUEUE_FILE.read_text())))
        except (ValueError, TypeError):
            return []
    return []


def save_rescan_queue(ids):
    RESCAN_QUEUE_FILE.write_text(json.dumps(sorted(set(ids))))


async def main():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()
    max_id_seen = state["last_message_id"]
    new_files = []

    async with TelegramClient(StringSession(SESSION), API_ID, API_HASH) as client:
        entity = await client.get_entity(CHANNEL)

        # ---- 1) Normal akış: son çekilen ID'den sonraki yeni mesajlar ----
        async for msg in client.iter_messages(entity, min_id=state["last_message_id"]):
            if not msg.photo and not msg.document:
                continue
            fname = RAW_DIR / f"{msg.id}.jpg"
            if fname.exists():
                continue
            await client.download_media(msg, file=str(fname))
            new_files.append({
                "path": str(fname),
                "date": msg.date.isoformat() if msg.date else None,
            })
            max_id_seen = max(max_id_seen, msg.id)

        state["last_message_id"] = max_id_seen
        save_state(state)

        # ---- 2) Yeniden tarama kuyruğu: admin'in görselsiz/reddedilen ürünler için
        #         işaretlediği ESKİ mesaj ID'lerini, min_id sınırından bağımsız,
        #         tek tek zorla yeniden çek. (Eski flyer diskte tutulmuyor,
        #         raw_flyers/ commit edilmiyor -> tek çare Telegram'dan tekrar indirmek.)
        rescan_ids = load_rescan_queue()
        failed_rescans = []
        if rescan_ids:
            print(f"Yeniden tarama kuyruğu: {len(rescan_ids)} mesaj ID'si işlenecek")
            messages = await client.get_messages(entity, ids=rescan_ids)
            for mid, msg in zip(rescan_ids, messages):
                if msg is None or (not msg.photo and not msg.document):
                    failed_rescans.append(mid)
                    continue
                fname = RAW_DIR / f"{msg.id}.jpg"
                await client.download_media(msg, file=str(fname))
                new_files.append({
                    "path": str(fname),
                    "date": msg.date.isoformat() if msg.date else None,
                })
            # Başarıyla işlenenleri kuyruktan düş; Telegram'dan silinmiş/erişilemeyenleri at (kurtarma imkanı yok)
            save_rescan_queue([])
            if failed_rescans:
                print(f"  Yeniden taranamadı (mesaj silinmiş/erişilemez): {failed_rescans}")

    print(f"Yeni indirilen dosya sayısı: {len(new_files)}")
    # Sonraki adıma (detect_products.py) hangi dosyaların yeni olduğunu bildir
    Path("pipeline/new_files.json").write_text(json.dumps(new_files))


if __name__ == "__main__":
    asyncio.run(main())
