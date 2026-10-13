"""Открывает чат (порт 3000) в интернет по публичной ссылке и держит её живой.

Пробует по очереди три бесплатных туннеля без регистрации:
  1. Cloudflare (cloudflared, протокол http2 через 443) — без ограничения по времени;
  2. localhost.run (ssh, порт 22);
  3. Pinggy (ssh через порт 443 — его в университетских сетях почти не закрывают; бесплатно 60 минут,
     потом ссылка сама переоткрывается с новым адресом).
Ссылка засчитывается, только когда она реально открывается из интернета. Если туннель упал,
скрипт переподключается. Текущее состояние пишется в logs/access.json: его читают run.sh и админка
(вкладка «Подключение», там же QR-код для одногруппников).

Запуск: python tools/tunnel.py            (обычно его запускает run_internet.sh или кнопка в админке)
        python tools/tunnel.py --prepare  (только скачать cloudflared и создать ssh-ключ, для install.sh)
"""
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
LOGS = ROOT / "logs"
STATE = LOGS / "access.json"
PORT = 3000
WIN = os.name == "nt"
NULL = "NUL" if WIN else "/dev/null"
KEY = TOOLS / "tunnel_key"
_ARCH = "arm64" if platform.machine().lower() in ("aarch64", "arm64") else "amd64"
CF_URL = ("https://github.com/cloudflare/cloudflared/releases/latest/download/"
          + ("cloudflared-windows-amd64.exe" if WIN else f"cloudflared-linux-{_ARCH}"))

child = None


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def write_state(**kw):
    """Атомарная запись состояния: админка не должна прочитать половину файла."""
    LOGS.mkdir(exist_ok=True)
    data = {"pid": os.getpid(), "beat": time.time(), "updated": now(), **kw}
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, STATE)


def say(text):
    print(f"[ТУННЕЛЬ] {text}", flush=True)


# ---------- подготовка ----------

def cloudflared_path():
    exe = TOOLS / ("cloudflared.exe" if WIN else "cloudflared")
    if exe.is_file():
        return str(exe)
    found = shutil.which("cloudflared")
    if found:
        return found
    say("Скачиваю cloudflared (около 50 МБ, один раз)...")
    TOOLS.mkdir(exist_ok=True)
    tmp = exe.with_suffix(".part")
    try:
        with urllib.request.urlopen(CF_URL, timeout=60) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(tmp, exe)
        if not WIN:
            os.chmod(exe, 0o755)
        return str(exe)
    except Exception as e:  # нет интернета или GitHub закрыт
        say(f"cloudflared не скачался: {e}")
        tmp.unlink(missing_ok=True)
        return None


def ensure_key():
    """Свой ssh-ключ: без него Pinggy спрашивает пароль, и скрипт без окна просто висит."""
    if KEY.is_file():
        return True
    keygen = shutil.which("ssh-keygen")
    if not keygen:
        return False
    TOOLS.mkdir(exist_ok=True)
    r = subprocess.run([keygen, "-q", "-t", "ed25519", "-N", "", "-C", "dental-agent-tunnel", "-f", str(KEY)],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return r.returncode == 0 and KEY.is_file()


SSH_OPTS = ["-o", "StrictHostKeyChecking=no", "-o", f"UserKnownHostsFile={NULL}", "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15"]


def providers():
    out = []
    cf = cloudflared_path()
    if cf:
        # http2 через 443, а не QUIC: в сетях университетов UDP часто закрыт (ошибка 1033)
        out.append(("Cloudflare", [cf, "tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4",
                                   "--url", f"http://127.0.0.1:{PORT}", "--http-host-header", "localhost"],
                    r"https://[a-z0-9-]+\.trycloudflare\.com", r"Registered tunnel connection"))
    ssh = shutil.which("ssh")
    if ssh:
        out.append(("localhost.run", [ssh, *SSH_OPTS, "-R", f"80:127.0.0.1:{PORT}", "nokey@localhost.run"],
                    r"https://[a-z0-9-]+\.lhr\.life", None))
        if ensure_key():
            out.append(("Pinggy", [ssh, "-p", "443", "-T", "-i", str(KEY), "-o", "IdentitiesOnly=yes",
                                   "-o", "BatchMode=yes", *SSH_OPTS, "-R", f"0:127.0.0.1:{PORT}", "free.pinggy.io"],
                        r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pinggy(?:-free)?\.link", None))
    return out


# ---------- запуск и проверка ----------

def stop_child():
    global child
    if child and child.poll() is None:
        child.terminate()
        try:
            child.wait(5)
        except subprocess.TimeoutExpired:
            child.kill()
    child = None


def public_ok(url, timeout=20):
    """Ссылка рабочая, если чат открывается по ней из интернета (а не только выдана туннелем)."""
    try:
        req = urllib.request.Request(url, headers={"user-agent": "dental-agent-tunnel-check"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status < 500
    except urllib.error.HTTPError as e:
        return e.code < 500  # 4xx от нашего прокси тоже значит «дошли до чата»
    except Exception:
        return False


def start(name, cmd, url_re, ready_re):
    """Запускает туннель и ждёт ссылку. Вывод идёт в файл: так ssh и cloudflared не зависнут на полном канале."""
    global child
    log = LOGS / f"tunnel_{name.split('.')[0].lower()}.log"
    LOGS.mkdir(exist_ok=True)
    f = open(log, "w", encoding="utf-8", errors="replace")
    flags = subprocess.CREATE_NO_WINDOW if WIN else 0
    child = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT, creationflags=flags)
    url, ready = None, ready_re is None
    for i in range(45):
        time.sleep(1)
        if i % 5 == 0:  # отмечаемся, чтобы админка видела «подключаюсь», а не «выключено»
            write_state(status="connecting", provider=name, public=None)
        text = log.read_text(encoding="utf-8", errors="replace")
        m = re.search(url_re, text)
        if m:
            url = m.group(0)
        if ready_re and re.search(ready_re, text):
            ready = True
        if url and ready:
            return url
        if child.poll() is not None:
            break
    tail = log.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-3:]
    say(f"{name}: ссылка не получена. {' | '.join(tail)[:300]}")
    stop_child()
    return None


def try_providers(order):
    for name, cmd, url_re, ready_re in order:
        write_state(status="connecting", provider=name, public=None)
        say(f"Пробую {name}...")
        url = start(name, cmd, url_re, ready_re)
        if not url:
            continue
        say(f"{name} выдал ссылку {url}, проверяю, что она открывается из интернета...")
        for _ in range(12):
            write_state(status="connecting", provider=name, public=None)
            if public_ok(url):
                return name, url
            if child is None or child.poll() is not None:
                break
            time.sleep(5)
        say(f"{name}: ссылка не открывается снаружи (сеть режет этот туннель)")
        stop_child()
    return None, None


def local_ok():
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=5)
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


def main():
    if "--prepare" in sys.argv:
        cf = cloudflared_path()
        key = ensure_key()
        say(f"cloudflared: {'готов' if cf else 'нет'}; ssh-ключ для запасного туннеля: {'готов' if key else 'нет'}")
        return

    def bye(*_):
        stop_child()
        write_state(status="stopped", provider=None, public=None)
        sys.exit(0)
    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)

    write_state(status="connecting", provider=None, public=None)
    while not local_ok():  # туннель без работающего чата отдаёт 502
        write_state(status="waiting_chat", provider=None, public=None)
        time.sleep(3)


    order = providers()
    if not order:
        write_state(status="failed", provider=None, public=None,
                    error="Нет ни cloudflared, ни ssh. Запусти install.sh с интернетом.")
        say("Нет ни cloudflared, ни ssh: туннель открыть нечем")
        return

    while True:
        name, url = try_providers(order)
        if not url:
            write_state(status="failed", provider=None, public=None,
                        error="Ни один туннель не открылся. Пробую снова через 30 секунд.")
            say("Ни один туннель не открылся, повтор через 30 секунд")
            time.sleep(30)
            continue
        since = now()
        write_state(status="ok", provider=name, public=url, since=since)
        say(f"ГОТОВО. Ссылка для одногруппников: {url}")
        (ROOT / "ссылка_на_чат.txt").write_text(url + "\n", encoding="utf-8")
        fails = 0
        while child is not None and child.poll() is None:
            time.sleep(10)
            fails = 0 if public_ok(url, timeout=15) else fails + 1
            if fails >= 3:  # полминуты не открывается — переподключаемся
                say(f"{name}: ссылка перестала открываться, переподключаюсь")
                break
            write_state(status="ok", provider=name, public=url, since=since)
        stop_child()
        write_state(status="connecting", provider=None, public=None, previous=url)
        say("Туннель закрылся, открываю заново (ссылка будет новой)")


if __name__ == "__main__":
    try:
        main()
    finally:
        stop_child()
