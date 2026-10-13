#!/usr/bin/env bash
# Собирает логи и базу в один архив, чтобы отправить в чат для разбора. Токен бота и ключ МИС скрываются.
source "$(dirname "$0")/tools/common.sh"
STAMP=$(date +%Y-%m-%d_%H-%M)
DEST_DIR="$HOME/Desktop"; [ -d "$DEST_DIR" ] || DEST_DIR="$HOME/Рабочий стол"; [ -d "$DEST_DIR" ] || DEST_DIR="$HOME"
DEST="$DEST_DIR/dental-agent-logs_$STAMP.tar.gz"
TMP=$(mktemp -d)
cp -r logs "$TMP/" 2>/dev/null
cp data/clinic.db "$TMP/" 2>/dev/null
[ -f .env ] && sed -E 's/^(TELEGRAM_BOT_TOKEN|TEST_TELEGRAM_CHAT_ID|MIS_KEY)\s*=.*/\1=(скрыто)/' .env > "$TMP/env_настройки.txt"
{ echo "версия: $(cat VERSION)"; uname -a; lsb_release -ds 2>/dev/null; nvidia-smi 2>&1 | head -15; ollama ps 2>&1; node -v 2>&1; } > "$TMP/система.txt"
tar -czf "$DEST" -C "$TMP" .
rm -rf "$TMP"
echo
ok "Логи собраны в файл:"
echo "  $DEST"
echo "Перетащи этот файл в чат с Клодом."
