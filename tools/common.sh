#!/usr/bin/env bash
# Общие функции для скриптов агента на Ubuntu. Подключается так: source tools/common.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p logs

export PYTHONUTF8=1 PYTHONIOENCODING=utf-8
export LOG_COLOR=false LOG_JSON=false
# Свои программы, поставленные без sudo: Node.js в .node, Ollama в .ollama, uv в ~/.local/bin
[ -d "$ROOT/.node/bin" ] && export PATH="$ROOT/.node/bin:$PATH"
[ -d "$ROOT/.ollama/bin" ] && export PATH="$ROOT/.ollama/bin:$PATH"
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
# Если в университете прописан прокси, запросы к самому себе (127.0.0.1) идут мимо него
export no_proxy="localhost,127.0.0.1,::1${no_proxy:+,$no_proxy}"
export NO_PROXY="$no_proxy"

PY="$ROOT/.venv/bin/python"
MODEL="qwen3:8b"
PORTS="3000 2024 8080 8090 8765"
UI_REPO="https://github.com/langchain-ai/agent-chat-ui.git"

if [ -t 1 ]; then G='\033[32m'; Y='\033[33m'; R='\033[31m'; C='\033[36m'; D='\033[2m'; N='\033[0m'
else G=''; Y=''; R=''; C=''; D=''; N=''; fi
ok()   { echo -e "${G}[OK]${N} $*"; }
info() { echo -e "${C}[..]${N} $*"; }
warn() { echo -e "${Y}[!!]${N} $*"; }
fail() { echo -e "${R}[!!] $*${N}"; echo "Сфотографируй этот экран и пришли в чат."; exit 1; }
step() { echo; echo -e "${Y}=== $* ===${N}"; }
has()  { command -v "$1" >/dev/null 2>&1; }

# Скачать файл: curl, wget или python (на чистой Ubuntu curl может не быть)
fetch() {
  if has curl; then curl -fL --retry 3 --connect-timeout 20 -o "$2" "$1"
  elif has wget; then wget -q --show-progress -O "$2" "$1"
  else python3 - "$1" "$2" <<'PYF'
import shutil, sys, urllib.request
with urllib.request.urlopen(sys.argv[1], timeout=60) as r, open(sys.argv[2], "wb") as f:
    shutil.copyfileobj(r, f)
PYF
  fi
}

# Ждать, пока адрес начнёт отвечать (без прокси). wait_url URL СЕКУНД
wait_url() {
  local i
  for ((i = 0; i < $2; i++)); do
    python3 - "$1" <<'PYW' 2>/dev/null && return 0
import sys, urllib.request
urllib.request.build_opener(urllib.request.ProxyHandler({})).open(sys.argv[1], timeout=2)
PYW
    sleep 1
  done
  return 1
}

# Убить процесс вместе с дочерними (pnpm -> node, langgraph -> python)
kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  kill -9 "$1" 2>/dev/null
}

# Окна run.sh/run_internet.sh, их журнал (tail) и туннель: точное совпадение аргументов, чужое не трогаем
agent_pids() {
  python3 - <<'PYA'
import os
out = []
for pid in filter(str.isdigit, os.listdir("/proc")):
    try:
        argv = open(f"/proc/{pid}/cmdline", "rb").read().decode(errors="ignore").split("\0")[:-1]
    except OSError:
        continue
    if len(argv) < 2:
        continue
    prog = os.path.basename(argv[0])
    script = os.path.basename(argv[1])
    if prog == "bash" and script in ("run.sh", "run_internet.sh") and len(argv) <= 3:
        out.append(pid)
    elif prog == "tail" and argv[1:4] == ["-n0", "-F", "logs/agent.log"]:
        out.append(pid)
    elif prog.startswith("python") and argv[1].endswith("tools/tunnel.py") and len(argv) == 2:
        out.append(pid)
print(" ".join(out))
PYA
}

# Службы прошлого запуска. Если окно терминала с run.sh закрыли, они могли остаться в фоне и держать порты:
# тогда новый запуск показал бы СТАРУЮ версию. Останавливаем всё, что слушает наши порты, и туннель.
# PID процессов, которые слушают порты (через /proc, без ss/lsof/fuser). port_pids 3000 2024 ...
port_pids() {
  python3 - "$@" <<'PYP'
import os, sys
ports = {int(p) for p in sys.argv[1:]}
inodes = set()
for f in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        for line in open(f).readlines()[1:]:
            parts = line.split()
            if parts[3] == "0A" and int(parts[1].rsplit(":", 1)[1], 16) in ports:  # 0A = LISTEN
                inodes.add(parts[9])
    except OSError:
        pass
pids = set()
for pid in filter(str.isdigit, os.listdir("/proc")):
    try:
        for fd in os.listdir(f"/proc/{pid}/fd"):
            link = os.readlink(f"/proc/{pid}/fd/{fd}")
            if link.startswith("socket:[") and link[8:-1] in inodes:
                pids.add(pid)
                break
    except OSError:
        pass
print(" ".join(sorted(pids)))
PYP
}

# Занятые порты из списка (слушает кто угодно, даже другой пользователь)
busy_ports() {
  python3 - "$@" <<'PYB'
import sys
ports, busy = {int(p) for p in sys.argv[1:]}, set()
for f in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        for line in open(f).readlines()[1:]:
            parts = line.split()
            port = int(parts[1].rsplit(":", 1)[1], 16)
            if parts[3] == "0A" and port in ports:
                busy.add(port)
    except OSError:
        pass
print(" ".join(map(str, sorted(busy))))
PYB
}

# Окна run.sh/run_internet.sh, их журнал (tail) и туннель: точное совпадение аргументов, чужое не трогаем
agent_pids() {
  python3 - <<'PYA'
import os
out = []
for pid in filter(str.isdigit, os.listdir("/proc")):
    try:
        argv = open(f"/proc/{pid}/cmdline", "rb").read().decode(errors="ignore").split("\0")[:-1]
    except OSError:
        continue
    if len(argv) < 2:
        continue
    prog = os.path.basename(argv[0])
    script = os.path.basename(argv[1])
    if prog == "bash" and script in ("run.sh", "run_internet.sh") and len(argv) <= 3:
        out.append(pid)
    elif prog == "tail" and argv[1:4] == ["-n0", "-F", "logs/agent.log"]:
        out.append(pid)
    elif prog.startswith("python") and argv[1].endswith("tools/tunnel.py") and len(argv) == 2:
        out.append(pid)
print(" ".join(out))
PYA
}

# Службы прошлого запуска. Если окно терминала с run.sh закрыли, они могли остаться в фоне и держать порты:
# тогда новый запуск показал бы СТАРУЮ версию. Останавливаем всё, что слушает наши порты, и туннель.
stop_old() {
  local pids p busy
  # службы на портах, туннель, а также забытые окна run.sh с журналом (кроме себя)
  pids="$(port_pids $PORTS) $(agent_pids)"
  pids=$(echo $pids | tr ' ' '\n' | grep -E '^[0-9]+$' | grep -v -x -e "$$" -e "$PPID" | sort -u | tr '\n' ' ')
  if [ -n "${pids// /}" ]; then
    warn "Останавливаю службы прошлого запуска, они держали порты (процессы: $pids)"
    for p in $pids; do kill_tree "$p"; done
    sleep 2
  fi
  busy=$(busy_ports $PORTS)
  [ -n "$busy" ] && warn "Порты всё ещё заняты: $busy. Возможно, их держит другой пользователь. Перезагрузи компьютер."
  return 0
}

# Основной адрес ПК в сети и все адреса (Wi-Fi + кабель). Без ip/hostname, через сокеты Python
lan_ips() {
  python3 - <<'PYI'
import socket, subprocess
main = ""
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("10.255.255.255", 1)); main = s.getsockname()[0]; s.close()
except OSError:
    pass
ips = []
try:
    ips = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3).stdout.split()
except Exception:
    pass
ips = [x for x in ips if x.count(".") == 3 and not x.startswith(("127.", "169.254.", "172.17."))]
if main.startswith("127.") or not main:
    main = ips[0] if ips else "127.0.0.1"
print(" ".join([main] + [x for x in ips if x != main]))
PYI
}

# Major-версия Node.js (0, если node нет)
node_major() { has node && node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }

# Python 3.11+ из системы (langgraph требует 3.11 и новее)
find_python() {
  local c
  for c in python3.13 python3.12 python3.11 python3; do
    if has "$c" && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
      command -v "$c"; return 0
    fi
  done
  return 1
}
