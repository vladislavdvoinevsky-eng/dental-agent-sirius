"""Отправка сообщений пациентам.
Telegram работает по-настоящему, если задан TELEGRAM_BOT_TOKEN и у пациента есть telegram_chat_id.
MAX и WhatsApp - заглушки: сообщение пишется в logs/outbox.log и в таблицу outbox.
"""
import json
import os
import urllib.request
from pathlib import Path

from agent.db import connect, now

LOG = Path(__file__).resolve().parent.parent / "logs" / "outbox.log"


def _log(channel, recipient, text):
    # Файл, база и окно терминала с run.sh пишутся независимо: ошибка в одном не теряет код в остальных
    print(f"[OUTBOX] {channel} -> {recipient}: {text}", flush=True)
    try:
        LOG.parent.mkdir(exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"[{now()}] {channel} -> {recipient}: {text}\n")
    except Exception as e:
        print(f"[OUTBOX] ошибка записи в файл: {e}", flush=True)
    try:
        with connect() as con:
            con.execute("CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, channel TEXT, recipient TEXT,"
                        " text TEXT, created_at TEXT)")
            con.execute("INSERT INTO outbox (channel, recipient, text, created_at) VALUES (?,?,?,?)",
                        (channel, recipient, text, now()))
    except Exception as e:
        print(f"[OUTBOX] ошибка записи в базу: {e}", flush=True)


def log_only(channel, recipient, text):
    """Запись в журнал сообщений без отправки (видно в админке, вкладка «Сообщения и коды»)."""
    try:
        _log(channel, recipient, text)
    except Exception as e:
        print(f"[OUTBOX] ошибка записи: {e}", flush=True)


def _telegram(chat_id, text):
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token or not chat_id:
        return False
    data = json.dumps({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception as e:
        print(f"[TELEGRAM] ошибка отправки: {e}", flush=True)
        return False


def send(channel, patient, text):
    """channel: telegram | max | whatsapp. patient: строка из таблицы patients."""
    if channel == "telegram":
        chat_id = patient["telegram_chat_id"] or os.getenv("TEST_TELEGRAM_CHAT_ID", "").strip()
        if _telegram(chat_id, text):
            _log("telegram", chat_id, text)
            return "отправлено в Telegram"
        _log("telegram(лог)", patient["phone"], text)
        return "Telegram не настроен, сообщение записано в журнал"
    _log(channel, patient["phone"], text)
    return f"отправлено в {channel.upper()} (учебная заглушка)"
