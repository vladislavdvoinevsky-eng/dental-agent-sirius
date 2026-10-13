#!/usr/bin/env bash
# Открыть порт 3000 в брандмауэре ufw, чтобы одногруппники могли открыть чат
source "$(dirname "$0")/tools/common.sh"
if ! has ufw; then ok "ufw не установлен, порт закрывать нечему"; exit 0; fi
if sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 3000/tcp && ok "Порт 3000 открыт. Перезапусти run.sh"
else
  ok "Брандмауэр ufw выключен, порт 3000 уже доступен. Если чат всё равно не открывается с других ПК,
     скорее всего Wi-Fi изолирует устройства: запускай bash run_internet.sh"
fi
