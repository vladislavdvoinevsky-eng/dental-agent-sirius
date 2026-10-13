#!/usr/bin/env bash
# Запуск агента на Ubuntu:  bash run.sh            (чат в локальной сети)
#                           bash run.sh --internet (ещё и ссылка через интернет, то же что run_internet.sh)
# Остановка: Ctrl+C в этом окне. Если окно закрыли, следующий run.sh сам остановит старые службы (или bash stop.sh).
source "$(dirname "$0")/tools/common.sh"
INTERNET=0
[ "$1" = "--internet" ] && INTERNET=1
VERSION=$(tr -d '[:space:]' < VERSION 2>/dev/null || echo "?")
echo -e "${C}Агент клиники, версия $VERSION (Ubuntu). Папка: $ROOT${N}"
[ -x "$PY" ] || fail "Нет окружения Python (.venv). Сначала установка:  bash install.sh"
has pnpm || fail "Нет pnpm. Сначала установка:  bash install.sh"
stop_old

# Контекст модели: 20480 помещается в 8 ГБ видеопамяти целиком (быстрее и качественнее, чем 40k с выгрузкой на процессор)
CTX=20480
[ -f .env ] || cp .env.example .env
sed -i 's/\r$//' .env
if grep -q '^OLLAMA_NUM_CTX' .env; then sed -i "s/^OLLAMA_NUM_CTX.*/OLLAMA_NUM_CTX=$CTX/" .env
else echo "OLLAMA_NUM_CTX=$CTX" >> .env; fi
export OLLAMA_NUM_CTX=$CTX
# Ключ МИС: агент передаёт его в заголовке, без ключа МИС не отвечает (защита от SSRF через чужие MCP)
if ! grep -q '^MIS_KEY=.' .env; then
  KEY=$("$PY" -c "import secrets; print(secrets.token_hex(16))")
  if grep -q '^MIS_KEY=' .env; then sed -i "s/^MIS_KEY=.*/MIS_KEY=$KEY/" .env; else printf '\nMIS_KEY=%s\n' "$KEY" >> .env; fi
fi
MIS_KEY=$(grep '^MIS_KEY=' .env | head -1 | cut -d= -f2- | tr -d ' ')

# Адрес этого ПК в сети университета и все остальные адреса (Wi-Fi + кабель)
read -r IP ALL_IPS <<< "$(lan_ips)"
ALL_IPS="$IP $ALL_IPS"
ORIGINS=$(printf '%s\n' $ALL_IPS "$IP" localhost 127.0.0.1 | sort -u | paste -sd, -)

PIDS=()
# start ИМЯ_ЛОГА команда...: процесс в своей группе, чтобы при остановке убить его вместе с дочерними
start() {
  local log=$1; shift
  setsid "$@" > "logs/$log.log" 2> "logs/$log.err.log" < /dev/null &
  PIDS+=($!)
}
cleanup() {
  trap - EXIT INT TERM HUP
  echo; echo "Останавливаю..."
  local p
  for p in "${PIDS[@]}"; do kill -TERM -- "-$p" 2>/dev/null; done
  sleep 1
  for p in "${PIDS[@]}"; do kill -KILL -- "-$p" 2>/dev/null; done
  exit 0
}
trap cleanup EXIT INT TERM HUP

if ! wait_url http://127.0.0.1:11434 2; then
  echo "Запускаю Ollama..."
  if systemctl list-unit-files 2>/dev/null | grep -q '^ollama.service'; then
    systemctl start ollama 2>/dev/null || sudo systemctl start ollama
  else
    OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=$CTX OLLAMA_HOST=127.0.0.1:11434 \
      start ollama ollama serve
  fi
  wait_url http://127.0.0.1:11434 30 || warn "Ollama не отвечает: агент не сможет отвечать (logs/ollama.err.log)"
fi

# Память агента начинаем с чистого листа: старые файлы после закрытого окна бывают битыми.
# Чаты при этом не теряются: шлюз поднимает переписку из базы (chat_log), когда чат открывают
rm -rf .langgraph_api
# База под текущую версию и расписание на 7 дней вперёд от сегодня (ничего не стирает)
if [ -f data/clinic.db ]; then "$PY" data/migrate.py; else "$PY" data/load_data.py; fi
"$PY" -c "import qrcode" 2>/dev/null || { echo "Ставлю пакет qrcode для QR-кодов..."; "$PY" -m pip install -q qrcode; }

echo "Запускаю MCP-сервер МИС (порт 8765)..."
start mcp "$PY" mcp_mis/server.py --http
sleep 3
echo "Запускаю админ-панель (порт 8080)..."
start admin "$PY" admin/server.py
echo "Запускаю агента (порт 2024)..."
start agent "$ROOT/.venv/bin/langgraph" dev --host 127.0.0.1 --port 2024 --no-browser --allow-blocking --no-reload
if ! wait_url http://127.0.0.1:2024/ok 90; then
  echo -e "${R}[!!] Агент не запустился. Последние строки лога:${N}"; tail -30 logs/agent.err.log; exit 1
fi
# Шлюз личного кабинета создаёт чаты через агента, поэтому стартует после него
echo "Запускаю личный кабинет (порт 8090)..."
start gateway "$PY" gateway/server.py
if ! wait_url http://127.0.0.1:8090/health 30; then
  echo -e "${R}[!!] Личный кабинет не запустился. Последние строки лога:${N}"; tail -20 logs/gateway.err.log; exit 1
fi
GWV=$("$PY" -c "import json, urllib.request as u; print(json.load(u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:8090/health', timeout=5)).get('version', ''))" 2>/dev/null)
[ "$GWV" = "$VERSION" ] || warn "На порту 8090 отвечает другая версия ($GWV вместо $VERSION). Останови всё: bash stop.sh, затем bash run.sh"

# ufw закрывает порт 3000? (без sudo не проверить, поэтому смотрим только если правила видны)
FW_BLOCKED=false
if has ufw && sudo -n true 2>/dev/null && sudo ufw status 2>/dev/null | grep -q "Status: active" \
   && ! sudo ufw status | grep -qE '^3000(/tcp)?\s+ALLOW'; then FW_BLOCKED=true; fi
# Адреса ПК для вкладки «Подключение» в админке
"$PY" - "$IP" "$FW_BLOCKED" $ALL_IPS <<'PYJ'
import json, sys, time
ip, blocked, rest = sys.argv[1], sys.argv[2] == "true", sys.argv[3:]
ips = [ip] + [x for x in rest if x != ip]
json.dump({"ips": ips, "port": 3000, "firewall_blocked": blocked, "updated": time.strftime("%Y-%m-%d %H:%M:%S")},
          open("logs/lan.json", "w", encoding="utf-8"), ensure_ascii=False)
PYJ
rm -f logs/access.json

# Туннель (run_internet.sh) запускаем сразу: он сам дождётся чата и проверит ссылку снаружи.
# Без него доступ через интернет можно открыть позже кнопкой в админке, вкладка «Подключение»
if [ $INTERNET = 1 ]; then
  echo "Открываю доступ через интернет (Cloudflare, запасные localhost.run и Pinggy)..."
  start tunnel.out "$PY" tools/tunnel.py
fi

# Интерфейс на закреплённой версии и поверх него защитный прокси и оформление клиники
source ui_patch/ui.sh
[ -d ui ] || git clone --depth 1 "$UI_REPO" ui
if sync_ui_version; then (cd ui && CI=true pnpm install); fi
[ -d ui/node_modules ] || (cd ui && CI=true pnpm install)
install_ui_patch
cat > ui/.env <<ENV
NEXT_PUBLIC_API_URL=http://$IP:3000/api
NEXT_PUBLIC_ASSISTANT_ID=agent
LANGGRAPH_API_URL=http://127.0.0.1:2024
LANGSMITH_API_KEY=local
CLINIC_GATEWAY_URL=http://127.0.0.1:8090
CLINIC_INTERNAL_KEY=$MIS_KEY
ALLOWED_DEV_ORIGINS=$ORIGINS,*.trycloudflare.com,*.lhr.life,*.pinggy.link,*.pinggy-free.link,*.run.pinggy-free.link
ENV
export ALLOWED_DEV_ORIGINS="$ORIGINS,*.trycloudflare.com,*.lhr.life,*.pinggy.link,*.pinggy-free.link,*.run.pinggy-free.link"

# Готовая сборка чата (next build + next start) вместо режима разработки: страница открывается сразу.
# Собираем только после установки или обновления оформления (метка ui/.clinic_build)
STAMP="$UI_COMMIT|$(find ui_patch -type f -printf '%T@\n' | sort -n | tail -1)"
PROD=0
[ -f ui/.next/BUILD_ID ] && [ "$(cat ui/.clinic_build 2>/dev/null)" = "$STAMP" ] && PROD=1
if [ $PROD = 0 ]; then
  echo "Собираю чат (один раз после установки или обновления, 1-3 минуты)..."
  rm -rf ui/.next
  if (cd ui && pnpm build > ../logs/ui_build.log 2>&1); then PROD=1
  else
    warn "Первый способ сборки не прошёл, пробую второй (webpack, ещё 1-3 минуты)..."
    rm -rf ui/.next
    (cd ui && pnpm exec next build --webpack > ../logs/ui_build_webpack.log 2>&1) && PROD=1
  fi
  if [ $PROD = 1 ]; then echo "$STAMP" > ui/.clinic_build
  else
    warn "Сборка чата не прошла. Запускаю в режиме разработки: первый заход в чат будет медленным (до 5 минут)."
    echo "     Причина (последние строки logs/ui_build.log), сфотографируй и пришли в чат:"
    tail -25 logs/ui_build.log | sed 's/^/     /'
  fi
fi
echo "Запускаю чат (порт 3000)..."
if [ $PROD = 1 ]; then start ui bash -c "cd ui && exec pnpm start -H 0.0.0.0 -p 3000"
else start ui bash -c "cd ui && exec pnpm dev -H 0.0.0.0 -p 3000"; fi
wait_url http://127.0.0.1:3000 180 >/dev/null
# в режиме разработки первая страница компилируется: ждём, пока она откроется
for i in $(seq 1 60); do
  python3 - <<'PYU' 2>/dev/null && break
import urllib.request
urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:3000/", timeout=120)
PYU
  sleep 5
done

PUBLIC=""
if [ $INTERNET = 1 ]; then
  echo "Жду ссылку через интернет (до 2 минут)..."
  for i in $(seq 1 60); do
    PUBLIC=$("$PY" -c "import json; s = json.load(open('logs/access.json', encoding='utf-8')); print(s['public'] if s.get('status') == 'ok' else '')" 2>/dev/null)
    [ -n "$PUBLIC" ] && break
    sleep 2
  done
  [ -z "$PUBLIC" ] && warn "Туннель пока не открылся. Он продолжает пробовать сам; ссылка появится в админке, вкладка «Подключение»"
fi
if [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && has xdg-open; then
  xdg-open "http://127.0.0.1:3000" >/dev/null 2>&1 &
  xdg-open "http://127.0.0.1:8080/connect" >/dev/null 2>&1 &
fi

echo
echo -e "${G}Готово.${N}"
[ -n "$PUBLIC" ] && echo -e "${G}  ЧАТ ДЛЯ ОДНОГРУППНИКОВ (через интернет): $PUBLIC${N}"
echo -e "${G}  Чат в локальной сети:               http://$IP:3000${N}"
for a in $ALL_IPS; do [ "$a" != "$IP" ] && echo -e "${D}  Запасной адрес чата:                http://$a:3000${N}"; done; true
echo -e "${G}  Админ-панель (только этот ПК):     http://127.0.0.1:8080  (QR-коды: вкладка «Подключение»)${N}"
[ $FW_BLOCKED = true ] && echo -e "${R}  [!!] ufw закрывает порт 3000: одногруппники не подключатся. Выполни: sudo ufw allow 3000/tcp${N}"
[ $INTERNET = 0 ] && echo -e "${D}  Одногруппники не подключаются по Wi-Fi? Админка -> «Подключение» -> «Открыть доступ через интернет»${N}"
echo -e "${G}  Инструкция: файл Инструкция.html или вкладка «Как это работает» в админке${N}"
grep -qiE '^DEMO_SHOW_CODE\s*=\s*(false|0|no|off)' .env || \
  echo -e "${Y}  [ВНИМАНИЕ] Демо-режим ВКЛЮЧЁН: код входа показывается прямо в окне входа. Для игры выключи кнопкой на «Сводке» в админке${N}"
echo "Ниже коды входа [SMS-КОД], вызовы инструментов, сообщения и срабатывания защиты. Не закрывай это окно."
echo "Остановить: Ctrl+C"
echo
touch logs/agent.log logs/gateway.log logs/tunnel.out.log
# Журнал читаем в фоне и ждём через wait: так Ctrl+C и закрытие окна сразу останавливают все службы
show_log() {
  tail -n0 -F logs/agent.log logs/gateway.log logs/tunnel.out.log 2>/dev/null |
    grep --line-buffered -E "SMS|TOOL|OUTBOX|MCP|SECURITY|ВХОД|ТУННЕЛЬ|ЧАТ|rror" |
    while IFS= read -r line; do
      case "$line" in
        *SMS-КОД*) echo -e "${Y}$line${N}" ;;
        *"ГОТОВО. Ссылка"*) echo -e "${G}$line${N}" ;;
        *) echo "$line" ;;
      esac
    done
}
setsid bash -c "$(declare -f show_log); Y='$Y'; G='$G'; N='$N'; show_log" &
PIDS+=($!)
wait $!
