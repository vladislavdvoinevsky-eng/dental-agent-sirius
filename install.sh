#!/usr/bin/env bash
# Установка AI-агента клиники на Ubuntu (22.04 / 24.04). Запуск из папки агента:  bash install.sh
# Можно запускать повторно: уже установленное пропускается, база не стирается.
# sudo нужен только по желанию (git, Ollama как служба, порт в ufw). Без sudo Node.js, Python и Ollama
# ставятся в саму папку агента (.node, .venv, .ollama).
source "$(dirname "$0")/tools/common.sh"
exec > >(tee -a logs/install.log) 2>&1
echo -e "${C}Установка агента клиники, версия $(cat VERSION 2>/dev/null), папка: $ROOT${N}"
case "$ROOT" in *" "*) warn "В пути к папке есть пробел. Лучше перенести агента в ~/dental-agent";; esac

ARCH=$(uname -m)
case "$ARCH" in x86_64) NARCH=x64; OARCH=amd64;; aarch64|arm64) NARCH=arm64; OARCH=arm64;; *) fail "Неизвестная архитектура $ARCH";; esac
SUDO_OK=0
try_sudo() {  # спросить один раз; без sudo ставим всё в папку агента
  [ $SUDO_OK = 1 ] && return 0
  [ $SUDO_OK = 2 ] && return 1
  has sudo || { SUDO_OK=2; return 1; }
  sudo -n true 2>/dev/null && { SUDO_OK=1; return 0; }
  local ans=""
  read -r -t 60 -p "Нужен пароль администратора (sudo) для: $1. Ввести? [Д/н]: " ans < /dev/tty || ans=""
  case "$ans" in н|Н|n|N|нет|no) SUDO_OK=2; info "Хорошо, без sudo"; return 1;; esac
  if sudo -v; then SUDO_OK=1; return 0; fi
  SUDO_OK=2; warn "sudo не получилось, ставлю без него"; return 1
}

step "1/7 Проверка"
for u in https://ollama.com https://pypi.org https://registry.npmjs.org https://github.com https://nodejs.org; do
  if python3 - "$u" <<'PYC' 2>/dev/null; then ok "$u"; else warn "$u недоступен"; fi
import sys, urllib.request
urllib.request.urlopen(urllib.request.Request(sys.argv[1], method="HEAD"), timeout=10)
PYC
done
if has nvidia-smi; then ok "Видеокарта: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null)"
else warn "nvidia-smi не найден: нет драйвера NVIDIA, модель пойдёт на процессоре (медленно).
     Поставить драйвер: sudo ubuntu-drivers install, затем перезагрузка."; fi
has python3 || fail "Нет python3. Выполни: sudo apt install python3"

step "2/7 Программы: Git, Node.js"
if ! has git; then
  try_sudo "установка git" && sudo apt-get update -qq && sudo apt-get install -y git
  has git || fail "Нет git. Выполни: sudo apt install git"
fi
ok "Git $(git --version | cut -d' ' -f3)"
if [ "$(node_major)" -lt 20 ]; then
  info "Ставлю Node.js 22 в папку агента (.node), без sudo"
  ver=$(python3 - <<'PYN'
import re, urllib.request
t = urllib.request.urlopen("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt", timeout=30).read().decode()
print(re.search(r"node-(v22[\d.]+)-linux", t).group(1))
PYN
)
  [ -n "$ver" ] || fail "Не удалось узнать версию Node.js (нет доступа к nodejs.org)"
  fetch "https://nodejs.org/dist/$ver/node-$ver-linux-$NARCH.tar.xz" /tmp/node.tar.xz || fail "Node.js не скачался"
  rm -rf .node && mkdir -p .node && tar -xJf /tmp/node.tar.xz -C .node --strip-components=1 || fail "Node.js не распаковался"
  rm -f /tmp/node.tar.xz
  export PATH="$ROOT/.node/bin:$PATH"
fi
ok "Node $(node -v)"
if ! has pnpm; then
  info "Ставлю pnpm"
  npm install -g pnpm --prefix "$ROOT/.node" >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1
  export PATH="$ROOT/.node/bin:$PATH"
fi
has pnpm || fail "pnpm не установился"
ok "pnpm $(pnpm -v)"

step "3/7 Ollama"
if ! has ollama; then
  if try_sudo "установка Ollama как системной службы"; then
    info "Ставлю Ollama официальным установщиком"
    fetch https://ollama.com/install.sh /tmp/ollama_install.sh && sh /tmp/ollama_install.sh
  fi
fi
if ! has ollama; then
  info "Ставлю Ollama в папку агента (.ollama), без sudo. Это около 1,5 ГБ"
  mkdir -p .ollama
  if fetch "https://ollama.com/download/ollama-linux-$OARCH.tgz" /tmp/ollama.tgz; then
    tar -xzf /tmp/ollama.tgz -C .ollama
  elif has zstd && fetch "https://ollama.com/download/ollama-linux-$OARCH.tar.zst" /tmp/ollama.tar.zst; then
    tar --use-compress-program=unzstd -xf /tmp/ollama.tar.zst -C .ollama
  fi
  rm -f /tmp/ollama.tgz /tmp/ollama.tar.zst
  export PATH="$ROOT/.ollama/bin:$PATH"
fi
has ollama || fail "Ollama не установилась"
ok "Ollama $(ollama -v 2>/dev/null | grep -o '[0-9][0-9.]*' | head -1)"
if ! wait_url http://127.0.0.1:11434 2; then
  info "Запускаю Ollama"
  if systemctl list-unit-files 2>/dev/null | grep -q '^ollama.service' && try_sudo "запуск службы Ollama"; then
    sudo systemctl start ollama
  else
    OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=20480 OLLAMA_HOST=127.0.0.1:11434 \
      setsid ollama serve > logs/ollama.log 2>&1 < /dev/null &
  fi
  wait_url http://127.0.0.1:11434 30 || fail "Ollama не запустилась (logs/ollama.log)"
fi
ok "Ollama работает"

step "4/7 Модель $MODEL (около 5 ГБ)"
if ollama list 2>/dev/null | grep -q "^$MODEL"; then
  ollama pull "$MODEL" || warn "Не удалось проверить обновление модели, работаю с уже скачанной"
else
  ollama pull "$MODEL" || fail "Модель не скачалась"
fi
ok "Модель на месте"

step "5/7 Python-окружение агента"
if [ ! -x "$PY" ]; then
  SYSPY=$(find_python)
  if [ -n "$SYSPY" ] && "$SYSPY" -m venv .venv 2>/dev/null && [ -x .venv/bin/pip ]; then
    ok "Окружение из $SYSPY"
  else
    # На Ubuntu 22.04 Python 3.10 (мало), а модуль venv часто не установлен. uv ставится без sudo
    # и сам скачивает Python 3.12
    rm -rf .venv
    info "Системный Python не подходит или нет модуля venv: ставлю uv и Python 3.12 (без sudo)"
    if ! has uv; then
      fetch https://astral.sh/uv/install.sh /tmp/uv_install.sh && sh /tmp/uv_install.sh >/dev/null
      export PATH="$HOME/.local/bin:$PATH"
    fi
    has uv || fail "uv не установился"
    uv venv --seed --python 3.12 .venv || fail "Не создалось окружение Python"
  fi
fi
"$PY" -m pip install --upgrade pip -q 2>/dev/null
"$PY" -m pip install -r requirements.txt || fail "pip не смог поставить пакеты"
[ -f .env ] || cp .env.example .env
if [ -f data/clinic.db ]; then "$PY" data/migrate.py; else "$PY" data/load_data.py; fi || fail "Не подготовилась база"
ok "Агент готов"
info "Готовлю доступ через интернет заранее: cloudflared и ssh-ключ (чтобы в университете ничего не качать)"
"$PY" tools/tunnel.py --prepare

step "6/7 Интерфейс Agent Chat UI"
source ui_patch/ui.sh
if [ ! -d ui ]; then git clone --depth 1 "$UI_REPO" ui || fail "Не скачался интерфейс с GitHub"; fi
sync_ui_version
install_ui_patch
(cd ui && CI=true pnpm install) || fail "pnpm install не прошёл"
ok "Интерфейс готов (соберётся при первом запуске run.sh, 1-3 минуты)"
if has ufw && try_sudo "проверить брандмауэр ufw и открыть порт 3000 для одногруппников"; then
  if sudo ufw status | grep -q "Status: active"; then sudo ufw allow 3000/tcp && ok "Порт 3000 открыт в ufw"
  else ok "Брандмауэр ufw выключен, порт 3000 доступен"; fi
fi

step "7/7 Проверка модели на видеокарте"
ollama run "$MODEL" "Ответь одним словом: привет" >/dev/null 2>&1
ollama ps
echo "В колонке PROCESSOR должно быть 100% GPU"
echo
ok "Установка закончена. Запуск агента:  bash run.sh"
