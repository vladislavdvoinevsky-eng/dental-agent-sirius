"""Вкладка «Подключение» админки и баннер кодов входа.

Подключение: адреса чата в локальной сети и ссылка через интернет (tools/tunnel.py), QR-коды,
проверка каждого способа, кнопки «открыть / закрыть доступ через интернет» без перезапуска run.sh
и экран для проектора с большим QR-кодом.
"""
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGS = ROOT / "logs"
STATE = LOGS / "access.json"
LAN = LOGS / "lan.json"
PORT = 3000


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def tunnel_state():
    """Состояние туннеля. Живой, только если tools/tunnel.py отметился в последние 40 секунд."""
    s = read_json(STATE)
    if not s or time.time() - float(s.get("beat") or 0) > 40:
        return {"status": "off"}
    return s


def lan_ips():
    """Адреса этого ПК: из logs/lan.json (пишет run.sh), иначе определяем сами."""
    data = read_json(LAN)
    ips = [ip for ip in data.get("ips", []) if ip and not ip.startswith(("127.", "169.254."))]
    if not ips:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))  # пакет не уходит, так ОС просто выбирает основной адрес
            ips = [s.getsockname()[0]]
            s.close()
        except OSError:
            ips = []
        try:
            for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
                if ip not in ips and not ip.startswith(("127.", "169.254.")):
                    ips.append(ip)
        except OSError:
            pass
    return ips, data


def reachable(url, timeout=1.2):
    try:
        urllib.request.urlopen(url, timeout=timeout)
        return True
    except urllib.error.HTTPError as e:
        return e.code < 500
    except Exception:
        return False


def qr_svg(text):
    """QR-код в SVG. Пакет qrcode ставится из requirements.txt; без него просто нет картинки."""
    try:
        import qrcode
        import qrcode.image.svg
    except ImportError:
        return ""
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    svg = img.to_string(encoding="unicode")
    # размер задаёт вёрстка: убираем фиксированные миллиметры
    return svg.replace('width="', 'data-w="', 1).replace('height="', 'data-h="', 1)


def start_tunnel():
    if tunnel_state().get("status") not in (None, "off", "stopped"):
        return
    LOGS.mkdir(exist_ok=True)
    out = open(LOGS / "tunnel.out.log", "a", encoding="utf-8")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen([sys.executable, str(ROOT / "tools" / "tunnel.py")], cwd=str(ROOT), stdin=subprocess.DEVNULL,
                     stdout=out, stderr=subprocess.STDOUT, creationflags=flags)
    # пока туннель не отметился сам, покажем «подключаюсь»
    STATE.write_text(json.dumps({"status": "connecting", "beat": time.time(), "pid": None}), encoding="utf-8")


def stop_tunnel():
    pid = tunnel_state().get("pid")
    if pid:
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(int(pid))], capture_output=True)
            else:
                os.kill(int(pid), signal.SIGTERM)
        except Exception:
            pass
    STATE.write_text(json.dumps({"status": "stopped", "beat": 0}), encoding="utf-8")


def links():
    """Все способы попасть в чат, лучший первым."""
    out = []
    t = tunnel_state()
    if t.get("status") == "ok" and t.get("public"):
        out.append({"kind": "internet", "url": t["public"], "ok": True,
                    "title": f"Через интернет ({t.get('provider')})", "hint": "Работает из любой сети, даже с мобильного интернета"})
    ips, _ = lan_ips()
    for ip in ips:
        url = f"http://{ip}:{PORT}"
        out.append({"kind": "lan", "url": url, "ok": reachable(url),
                    "title": "Локальная сеть", "hint": "Только для тех, кто в той же сети Wi-Fi или кабеле"})
    out.sort(key=lambda x: (not x["ok"], x["kind"] != "internet"))
    return out


# ---------- коды входа ----------

def fmt_phone(p):
    p = str(p or "")
    return f"+7 {p[1:4]} {p[4:7]}-{p[7:9]}-{p[9:11]}" if len(p) == 11 else "+" + p


def fresh_codes(q):
    """Коды входа за последние 10 минут, которые ещё не использованы."""
    since = (datetime.now() - timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S")
    return q("""SELECT l.*, p.full_name FROM login_codes l LEFT JOIN patients p ON p.phone=l.phone
                WHERE l.used=0 AND l.created_at >= ? ORDER BY l.id DESC LIMIT 6""", (since,))
