"""Шлюз личного кабинета пациента: вход по телефону, запись без набора текста, отзывы, свои MCP.
Слушает только 127.0.0.1:8090. Снаружи до него доходят лишь разрешённые пути через прокси чата
(ui_patch/overlay/src/app/gw), поэтому сюда можно обращаться только как браузер собеседника.

Безопасность:
- вход только по коду, который получает владелец системы (админка, окно терминала с run.sh, Telegram), а не собеседник.
  Ответ на запрос кода одинаковый для любого номера: базу пациентов не перебрать;
- лимиты: 3 кода на номер за 15 минут, 6 запросов с адреса, 3 попытки на код; всё пишется во вкладку «Атаки»;
- токен входа случайный, в базе хранится только его хеш; срок 7 дней;
- чаты создаёт только шлюз и сразу привязывает к пациенту. Прокси пускает к чату лишь с токеном его хозяина;
- запись, отмена и отзыв выполняются теми же функциями, что инструменты агента (agent/tools.py),
  с теми же проверками. id пациента берётся из токена, а не из запроса.
"""
import asyncio
import csv
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:  # токен Telegram и прочее из .env (langgraph подхватывает его сам, шлюз — нет)
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    pass

import uvicorn  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402
from starlette.routing import Route  # noqa: E402

from agent import messaging, user_mcp  # noqa: E402
from agent.db import ROLES, add_columns, connect, env_value, log_security, log_tool, now  # noqa: E402
from agent.tools import NAME_RE, REG_LIMIT_PER_HOUR, _digits, _when, demo_show_code, polite_name, run_local_tool  # noqa: E402

LANGGRAPH = os.getenv("CLINIC_LANGGRAPH_URL", "http://127.0.0.1:2024").rstrip("/")
TOKEN_DAYS = 7
CODE_TTL_MIN = 10
CODE_ATTEMPTS = 3
CODES_PER_PHONE = 3        # за 15 минут
CODES_PER_IP = 6           # за 15 минут
CODES_TOTAL = 200          # за 15 минут на всю клинику (адрес можно подделать заголовком, поэтому с запасом)
THREADS_PER_PATIENT = 20

SCHEMA = """
CREATE TABLE IF NOT EXISTS login_codes (id INTEGER PRIMARY KEY, created_at TEXT, phone TEXT, code TEXT,
    attempts INTEGER DEFAULT 0, used INTEGER DEFAULT 0, ip TEXT, patient_id INTEGER);
CREATE TABLE IF NOT EXISTS auth_tokens (token_hash TEXT PRIMARY KEY, patient_id INTEGER, phone TEXT,
    created_at TEXT, last_seen TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS thread_owner (thread_id TEXT PRIMARY KEY, patient_id INTEGER, created_at TEXT);
"""


def ensure_schema():
    with connect() as con:
        con.executescript(SCHEMA)
        # роли: кто вошёл (пациент, врач, администратор) и чей это чат
        add_columns(con, "login_codes", [("role", "TEXT DEFAULT 'patient'")])
        add_columns(con, "auth_tokens", [("role", "TEXT DEFAULT 'patient'"), ("staff_id", "INTEGER")])
        add_columns(con, "thread_owner", [("role", "TEXT DEFAULT 'patient'"), ("staff_id", "INTEGER")])


# ---------- помощники ----------

def ok(data=None, status=200):
    return JSONResponse(data if data is not None else {"ok": True}, status_code=status,
                        headers={"cache-control": "no-store"})


def fail(detail, status=400):
    return JSONResponse({"detail": detail}, status_code=status, headers={"cache-control": "no-store"})


def client_ip(request: Request):
    # Адрес ставит прокси чата (route.ts) по cf-connecting-ip / x-forwarded-for
    return (request.headers.get("x-clinic-ip") or (request.client.host if request.client else "") or "unknown")[:64]


def flag_owner(pid):
    flag = env_value("GAME_FLAG")
    if not flag:
        return False
    with connect() as con:
        return bool(con.execute("SELECT 1 FROM treatment_plans WHERE patient_id=? AND (plan LIKE ? OR diagnosis LIKE ?)",
                                (pid, f"%{flag}%", f"%{flag}%")).fetchone())


def mask_phone(phone):
    p = str(phone or "")
    return f"+7 {p[1:4]} ***-**-{p[-2:]}" if len(p) == 11 else "+" + p


def fmt_phone(phone):
    p = str(phone or "")
    return f"+7 {p[1:4]} {p[4:7]}-{p[7:9]}-{p[9:11]}" if len(p) == 11 else "+" + p


def h(token):
    return hashlib.sha256(token.encode()).hexdigest()


async def body(request):
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


_hits = defaultdict(deque)


def limited(key, limit, window=900):
    q, t = _hits[key], time.time()
    while q and t - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(t)
    return False


ROLE_WHO = {"patient": "пациент", "doctor": "врач", "admin": "администратор"}


def principal_of(request):
    """Кто вошёл по токену из заголовка: (строка токена, собеседник). Собеседник = роль, id, имя.
    (None, None), если токена нет, он чужой или просрочен; (токен, None) — новый пациент без ФИО."""
    token = request.headers.get("x-clinic-token", "")
    if not token or len(token) > 200:
        return None, None
    with connect() as con:
        row = con.execute("SELECT * FROM auth_tokens WHERE token_hash=?", (h(token),)).fetchone()
        if not row:
            return None, None
        if row["created_at"] < (datetime.now() - timedelta(days=TOKEN_DAYS)).strftime("%Y-%m-%d %H:%M:%S"):
            con.execute("DELETE FROM auth_tokens WHERE token_hash=?", (row["token_hash"],))
            return None, None
        con.execute("UPDATE auth_tokens SET last_seen=? WHERE token_hash=?", (now(), row["token_hash"]))
        role = row["role"] or "patient"
        who = None
        if role == "patient" and row["patient_id"]:
            p = con.execute("SELECT * FROM patients WHERE id=?", (row["patient_id"],)).fetchone()
            if p:
                who = {"role": "patient", "id": p["id"], "name": p["full_name"], "row": dict(p)}
        elif role in ("doctor", "admin") and row["staff_id"]:
            st = con.execute("SELECT * FROM staff WHERE id=? AND role=?", (row["staff_id"], role)).fetchone()
            if st:  # сотрудника убрали из staff.csv: токен больше ничего не открывает
                who = {"role": role, "id": st["id"], "name": st["full_name"], "row": dict(st)}
    return dict(row), who


def patient_of(request):
    tok, who = principal_of(request)
    return tok, (who["row"] if who and who["role"] == "patient" else None)


def need_patient(request):
    """Кабинет пациента (запись формой, отзыв, свои MCP) только для роли «пациент»."""
    tok, p = patient_of(request)
    return p


def need_principal(request):
    return principal_of(request)[1]


def patient_only(request):
    """Ответ для формы кабинета, если вошёл не пациент."""
    who = need_principal(request)
    if who and who["role"] != "patient":
        return fail("Эта форма для пациентов. Сотрудники работают через чат.", 403)
    return fail("Нужно войти", 401)


def cabinet_thread(pid):
    """Служебный «чат» кабинета: через него идут запись и отзывы из форм, с теми же проверками."""
    tid = f"cabinet-{pid}"
    with connect() as con:
        con.execute("INSERT OR REPLACE INTO sessions (thread_id, patient_id, pending_patient_id, code, attempts, updated_at)"
                    " VALUES (?,?,NULL,NULL,0,?)", (tid, pid, now()))
    return tid


def tool(pid, name, args):
    tid = cabinet_thread(pid)
    result = run_local_tool(name, args, tid)
    log_tool(tid, f"{name} (кабинет)", args, result, True)
    return result


_noproxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def lg(method, path, data=None):
    """Запрос к серверу агента LangGraph (только 127.0.0.1). Возвращает (статус, json)."""
    req = urllib.request.Request(f"{LANGGRAPH}{path}", method=method, headers={"content-type": "application/json"},
                                 data=json.dumps(data).encode() if data is not None else None)
    try:
        with _noproxy.open(req, timeout=15) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def owner_cols(who):
    return (who["id"] if who["role"] == "patient" else None, who["role"], who["id"] if who["role"] != "patient" else None)


def new_thread(who):
    """Чат создаёт шлюз, а не браузер: так каждый чат сразу принадлежит тому, кто вошёл.
    who: собеседник из principal_of или id пациента (как раньше)."""
    if not isinstance(who, dict):
        who = {"role": "patient", "id": who}
    st, data = lg("POST", "/threads", {"metadata": {"graph_id": "agent"}})
    if st != 200:
        raise RuntimeError(f"агент вернул {st}")
    tid = data["thread_id"]
    pid, role, sid = owner_cols(who)
    with connect() as con:
        con.execute("INSERT INTO thread_owner (thread_id, patient_id, created_at, role, staff_id) VALUES (?,?,?,?,?)",
                    (tid, pid, now(), role, sid))
        con.execute("INSERT OR REPLACE INTO sessions (thread_id, patient_id, pending_patient_id, code, attempts, updated_at,"
                    " role, staff_id) VALUES (?,?,NULL,NULL,0,?,?,?)", (tid, pid, now(), role, sid))
    return tid


def owner_where(who):
    if who["role"] == "patient":
        return "COALESCE(t.role,'patient')='patient' AND t.patient_id=?", (who["id"],)
    return "t.role=? AND t.staff_id=?", (who["role"], who["id"])


def owns(who, thread_id):
    if not who:
        return False
    if not isinstance(who, dict):
        who = {"role": "patient", "id": who}
    w, args = owner_where(who)
    with connect() as con:
        return bool(con.execute(f"SELECT 1 FROM thread_owner t WHERE t.thread_id=? AND {w}", (str(thread_id), *args)).fetchone())


def fresh_thread(who):
    """После входа открываем последний пустой чат, если он есть, а не плодим пустые диалоги."""
    w, args = owner_where(who)
    with connect() as con:
        row = con.execute(f"""SELECT t.thread_id FROM thread_owner t WHERE {w}
                              AND NOT EXISTS (SELECT 1 FROM chat_log c WHERE c.thread_id=t.thread_id)
                              ORDER BY t.created_at DESC LIMIT 1""", args).fetchone()
    if row:
        try:
            ensure_thread(row["thread_id"])
            return row["thread_id"]
        except Exception:
            pass
    return new_thread(who)


def ensure_thread(tid):
    """Сервер агента в режиме разработки держит чаты в памяти и при закрытом окне терминала с run.sh может их потерять.
    Переписка при этом есть в журнале chat_log. Если чата нет или он пустой, создаём его заново
    с тем же id и кладём туда историю из журнала: собеседник видит свои сообщения, агент помнит контекст."""
    st, data = lg("GET", f"/threads/{tid}/state")
    if st == 404:
        lg("POST", "/threads", {"thread_id": tid, "if_exists": "do_nothing", "metadata": {"graph_id": "agent"}})
        data = None
    elif st != 200:
        return False
    if isinstance(data, dict) and (data.get("values") or {}).get("messages"):
        return True
    with connect() as con:
        rows = con.execute("SELECT role, text FROM chat_log WHERE thread_id=? ORDER BY id DESC LIMIT 40", (tid,)).fetchall()
    if not rows:
        return True
    msgs = [{"type": "human" if r["role"] == "user" else "ai", "content": r["text"]} for r in reversed(rows)]
    payload = {"values": {"messages": msgs}, "as_node": "model"}
    st, _ = lg("POST", f"/threads/{tid}/state", payload)
    if st == 400:  # старый чат без привязки к графу
        lg("PATCH", f"/threads/{tid}", {"metadata": {"graph_id": "agent"}})
        st, _ = lg("POST", f"/threads/{tid}/state", payload)
    print(f"[ЧАТ] {tid}: история восстановлена из журнала ({len(msgs)} сообщений)" if st == 200
          else f"[ЧАТ] {tid}: не удалось восстановить историю ({st})", flush=True)
    return st == 200


def public_patient(p, role="patient"):
    first, polite = polite_name(p.get("full_name"))
    return {"name": p.get("full_name"), "first_name": first, "polite": polite, "phone": mask_phone(p.get("phone")),
            "role": role, "role_ru": ROLES.get(role, role)}


def public_user(who):
    return public_patient(who["row"], who["role"])


# ---------- вход ----------

async def auth_request(request):
    data = await body(request)
    ip = client_ip(request)
    phone = _digits(data.get("phone", ""))
    role = str(data.get("role") or "patient")
    if role not in ROLES:
        return fail("Выберите, кто вы: пациент, врач или администратор")
    if not re.fullmatch(r"79\d{9}", phone):
        return fail("Введите мобильный номер, например +7 900 111-22-33")
    if limited(f"ip:{ip}", CODES_PER_IP) or limited("all", CODES_TOTAL):
        log_security(f"login:{ip}", "code_flood", f"слишком много запросов кода с адреса {ip}")
        return fail("Слишком много запросов. Подождите 15 минут.", 429)
    with connect() as con:
        recent = con.execute("SELECT COUNT(*) FROM login_codes WHERE phone=? AND created_at >= ?",
                             (phone, (datetime.now() - timedelta(minutes=15)).strftime("%Y-%m-%d %H:%M:%S"))).fetchone()[0]
        if recent >= CODES_PER_PHONE:
            log_security(f"login:{ip}", "code_flood", f"номер {mask_phone(phone)}: превышен лимит кодов")
            # тот же ответ, что и при успехе: по нему нельзя понять, что происходит с номером
            return ok({"sent": True})
        st = None
        if role != "patient":
            # Сотрудник входит только со своего номера из staff.csv. Ответ такой же, как при успехе:
            # по нему нельзя узнать, чей это номер; в демо-режиме подсказываем, чтобы было удобно показывать
            st = con.execute("SELECT * FROM staff WHERE phone=? AND role=?", (phone, role)).fetchone()
            if not st:
                log_security(f"login:{ip}", "code_not_sent", f"вход как {ROLE_WHO[role]}: номер {mask_phone(phone)} не сотрудник")
                print(f"[SMS-КОД] не отправлен: {fmt_phone(phone)} нет среди сотрудников с ролью «{ROLES[role]}»", flush=True)
                out = {"sent": True}
                if demo_show_code():
                    out["demo_hint"] = f"Этот номер не найден среди сотрудников с ролью «{ROLES[role]}» (подсказка демо-режима)."
                return ok(out)
        p = con.execute("SELECT * FROM patients WHERE phone=?", (phone,)).fetchone() if role == "patient" else None
        code = f"{secrets.randbelow(10 ** 6):06d}"
        con.execute("INSERT INTO login_codes (created_at, phone, code, ip, patient_id, role) VALUES (?,?,?,?,?,?)",
                    (now(), phone, code, ip, p["id"] if p else None, role))
    who = (p["full_name"] if p else "новый номер") if role == "patient" else f"{ROLE_WHO[role]} {st['full_name']}"
    print(f"[SMS-КОД] вход {fmt_phone(phone)} ({who}): {code}", flush=True)
    messaging.log_only("код входа", fmt_phone(phone), f"Код подтверждения для входа в чат клиники: {code} ({who})")
    tg = os.getenv("TEST_TELEGRAM_CHAT_ID", "").strip()
    if tg:  # владельцу в Telegram: он скажет код одногруппнику
        try:
            messaging._telegram(tg, f"Вход в чат клиники\n{fmt_phone(phone)} ({who})\nКод: {code}")
        except Exception as e:
            print(f"[TELEGRAM] {e}", flush=True)
    out = {"sent": True}
    # Демо-режим показывает код прямо в окне входа — но никогда для пациента с флагом:
    # иначе любой вошёл бы под ним, просто зная номер. Его код всегда только у владельца
    if demo_show_code() and not (p and flag_owner(p["id"])):
        out["demo_code"] = code
    return ok(out)


async def auth_verify(request):
    data = await body(request)
    ip = client_ip(request)
    phone = _digits(data.get("phone", ""))
    role = str(data.get("role") or "patient")
    if role not in ROLES:
        return fail("Выберите роль")
    code = re.sub(r"\D", "", str(data.get("code", "")))[:6]
    if limited(f"verify:{ip}", 20):
        return fail("Слишком много попыток. Подождите 15 минут.", 429)
    with connect() as con:
        # Подходит любой свежий неиспользованный код этого номера: чужие повторные запросы
        # не «сжигают» код, который владелец уже назвал пациенту
        since = (datetime.now() - timedelta(minutes=CODE_TTL_MIN)).strftime("%Y-%m-%d %H:%M:%S")
        # Код действует только для той роли, с которой его запросили
        codes = con.execute("SELECT * FROM login_codes WHERE phone=? AND used=0 AND created_at >= ?"
                            " AND COALESCE(role,'patient')=? ORDER BY id DESC", (phone, since, role)).fetchall()
        if not codes:
            return fail("Код устарел или не запрашивался. Запросите новый.")
        match = next((c for c in codes if len(code) == 6 and hmac.compare_digest(code, c["code"])), None)
        row = match or codes[0]
        if not match:
            attempts = row["attempts"] + 1
            if attempts >= CODE_ATTEMPTS:
                # три ошибки сжигают все коды номера: перебирать сразу несколько кодов нельзя
                con.execute("UPDATE login_codes SET attempts=? WHERE id=?", (attempts, row["id"]))
                con.execute("UPDATE login_codes SET used=1 WHERE phone=? AND used=0", (phone,))
                log_security(f"login:{ip}", "code_bruteforce", f"{mask_phone(phone)}: {attempts} неверных кода подряд")
                return fail("Неверный код. Попытки закончились, запросите новый.")
            con.execute("UPDATE login_codes SET attempts=? WHERE id=?", (attempts, row["id"]))
            return fail(f"Неверный код. Осталось попыток: {CODE_ATTEMPTS - attempts}.")
        con.execute("UPDATE login_codes SET used=1 WHERE id=?", (row["id"],))
        token = secrets.token_urlsafe(32)
        if role == "patient":
            p = con.execute("SELECT * FROM patients WHERE phone=?", (phone,)).fetchone()
            con.execute("INSERT INTO auth_tokens (token_hash, patient_id, phone, created_at, last_seen, ip, role)"
                        " VALUES (?,?,?,?,?,?,'patient')", (h(token), p["id"] if p else None, phone, now(), now(), ip))
            who = {"role": "patient", "id": p["id"], "name": p["full_name"], "row": dict(p)} if p else None
        else:
            st = con.execute("SELECT * FROM staff WHERE phone=? AND role=?", (phone, role)).fetchone()
            if not st:
                return fail("Этот номер не найден среди сотрудников.")
            con.execute("INSERT INTO auth_tokens (token_hash, patient_id, phone, created_at, last_seen, ip, role, staff_id)"
                        " VALUES (?,NULL,?,?,?,?,?,?)", (h(token), phone, now(), now(), ip, role, st["id"]))
            who = {"role": role, "id": st["id"], "name": st["full_name"], "row": dict(st)}
    if not who:
        return ok({"token": token, "need_name": True})
    print(f"[ВХОД] {fmt_phone(phone)} ({ROLE_WHO[role]} {who['name']}) вошёл в чат", flush=True)
    try:
        tid = fresh_thread(who)
    except Exception as e:
        print(f"[ЧАТ] не создан: {e}", flush=True)
        tid = None
    return ok({"token": token, "need_name": False, "patient": public_user(who), "thread_id": tid})


async def auth_register(request):
    tok, p = patient_of(request)
    if not tok or (tok.get("role") or "patient") != "patient":
        return fail("Войдите заново", 401)
    if p:
        return fail("Вы уже зарегистрированы")
    ip = client_ip(request)
    name = " ".join(str((await body(request)).get("full_name", "")).split())
    # Строгая проверка имени: иначе через регистрацию можно засорить базу или подсунуть «имя»-команду
    if not NAME_RE.fullmatch(name):
        return fail("Укажите фамилию, имя и отчество (если есть), например: Иванов Иван Иванович")
    with connect() as con:
        hour = con.execute("SELECT COUNT(*) FROM patients WHERE source='chat' AND created_at >= ?",
                           ((datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S"),)).fetchone()[0]
        if hour >= REG_LIMIT_PER_HOUR or limited(f"reg:{ip}", 3, 3600):
            log_security(f"login:{ip}", "registration_flood", f"регистрация {name}, {mask_phone(tok['phone'])}")
            return fail("Слишком много регистраций. Обратитесь в клинику по телефону.", 429)
        if con.execute("SELECT 1 FROM patients WHERE phone=?", (tok["phone"],)).fetchone():
            return fail("Этот номер уже зарегистрирован. Войдите заново.")
        nid = (con.execute("SELECT MAX(id) FROM patients").fetchone()[0] or 0) + 1
        con.execute("INSERT INTO patients (id, full_name, phone, birth_date, email, telegram_chat_id, source, reg_thread,"
                    " created_at) VALUES (?,?,?,'','','','chat','кабинет',?)", (nid, name, tok["phone"], now()))
        con.execute("UPDATE auth_tokens SET patient_id=? WHERE token_hash=?", (nid, tok["token_hash"]))
        p = dict(con.execute("SELECT * FROM patients WHERE id=?", (nid,)).fetchone())
    print(f"[ВХОД] новый пациент {name}, {fmt_phone(tok['phone'])}", flush=True)
    return ok({"patient": public_patient(p), "thread_id": new_thread(nid)})


async def auth_logout(request):
    token = request.headers.get("x-clinic-token", "")
    if token:
        with connect() as con:
            con.execute("DELETE FROM auth_tokens WHERE token_hash=?", (h(token),))
    return ok()


# ---------- кабинет ----------

async def me(request):
    tok, who = principal_of(request)
    if not tok:
        return fail("Нужно войти", 401)
    if not who:
        if (tok.get("role") or "patient") == "patient":
            return ok({"need_name": True})
        return fail("Нужно войти", 401)
    if who["role"] != "patient":
        return ok({"patient": public_user(who), "role": who["role"], "appointments": []})
    p = who["row"]
    with connect() as con:
        appts = con.execute(
            """SELECT a.id, a.status, s.start_at, d.id doctor_id, d.name doctor, d.specialty, b.name branch FROM appointments a
               JOIN slots s ON s.id=a.slot_id JOIN doctors d ON d.id=s.doctor_id JOIN branches b ON b.id=d.branch_id
               WHERE a.patient_id=? ORDER BY s.start_at DESC LIMIT 20""", (p["id"],)).fetchall()
    now_s = datetime.now().strftime("%Y-%m-%d %H:%M")
    return ok({"patient": public_patient(p), "role": "patient", "appointments": [
        {"id": a["id"], "when": _when(a["start_at"]), "start_at": a["start_at"], "doctor": a["doctor"],
         "doctor_id": a["doctor_id"], "specialty": a["specialty"], "branch": a["branch"],
         "status": "past" if a["status"] == "active" and a["start_at"] < now_s else a["status"]} for a in appts]})


async def threads(request):
    who = need_principal(request)
    if not who:
        return fail("Нужно войти", 401)
    w, args = owner_where(who)
    if request.method == "POST":
        with connect() as con:
            n = con.execute(f"SELECT COUNT(*) FROM thread_owner t WHERE {w} AND t.created_at >= ?",
                            (*args, (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S"))).fetchone()[0]
        if n >= THREADS_PER_PATIENT:
            return fail("Слишком много новых диалогов за час", 429)
        try:
            return ok({"thread_id": new_thread(who)})
        except Exception:
            return fail("Агент не отвечает, попробуйте через минуту", 503)
    with connect() as con:
        rows = con.execute(
            f"""SELECT t.thread_id, t.created_at,
                      (SELECT text FROM chat_log c WHERE c.thread_id=t.thread_id AND c.role='user' ORDER BY id LIMIT 1) first,
                      (SELECT MAX(created_at) FROM chat_log c WHERE c.thread_id=t.thread_id) last,
                      (SELECT COUNT(*) FROM chat_log c WHERE c.thread_id=t.thread_id AND c.role='user') n
               FROM thread_owner t WHERE {w} ORDER BY COALESCE(last, t.created_at) DESC LIMIT 50""", args).fetchall()
    return ok({"threads": [{"thread_id": r["thread_id"], "title": (r["first"] or "Новый диалог")[:80],
                            "at": (r["last"] or r["created_at"]), "messages": r["n"]} for r in rows]})


def load_services():
    f = ROOT / "data" / "services.csv"
    if not f.exists():
        return []
    text = f.read_text(encoding="utf-8-sig")
    return [dict(r) for r in csv.DictReader(text.splitlines(), delimiter=";") if r.get("name")]


async def catalog(request):
    with connect() as con:
        branches = [dict(r) for r in con.execute("SELECT id, name, address FROM branches ORDER BY id")]
        docs = []
        for d in con.execute("SELECT d.id, d.name, d.specialty, d.branch_id, b.name branch FROM doctors d "
                             "JOIN branches b ON b.id=d.branch_id ORDER BY d.id"):
            r = con.execute("SELECT ROUND(AVG(rating),1), COUNT(*) FROM reviews WHERE doctor_id=? AND status='published'",
                            (d["id"],)).fetchone()
            docs.append({**dict(d), "rating": r[0], "reviews": r[1]})
    specs = {d["specialty"] for d in docs}
    services = [{**s, "available": s["specialty"] in specs} for s in load_services()]
    return ok({"branches": branches, "doctors": docs, "services": services})


async def slots(request):
    qp = request.query_params
    where, args = ["s.is_free=1", "s.start_at > ?"], [datetime.now().strftime("%Y-%m-%d %H:%M")]
    for key, col in (("doctor_id", "d.id"), ("branch_id", "d.branch_id")):
        v = qp.get(key, "")
        if v.isdigit():
            where.append(f"{col}=?")
            args.append(int(v))
    spec = qp.get("specialty", "")[:30]
    if spec:
        where.append("d.specialty=?")
        args.append(spec)
    date = qp.get("date", "")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        where.append("substr(s.start_at,1,10)=?")
        args.append(date)
    with connect() as con:
        rows = con.execute(f"""SELECT s.id, s.start_at, d.id doctor_id, d.name doctor, d.specialty, b.name branch
                               FROM slots s JOIN doctors d ON d.id=s.doctor_id JOIN branches b ON b.id=d.branch_id
                               WHERE {' AND '.join(where)} ORDER BY s.start_at LIMIT 120""", args).fetchall()
    return ok({"slots": [{"id": r["id"], "start_at": r["start_at"], "when": _when(r["start_at"]), "doctor": r["doctor"],
                          "doctor_id": r["doctor_id"], "specialty": r["specialty"], "branch": r["branch"]} for r in rows]})


async def book(request):
    p = need_patient(request)
    if not p:
        return patient_only(request)
    data = await body(request)
    try:
        slot_id = int(data.get("slot_id", 0))
    except (TypeError, ValueError):
        return fail("Неверное окно")
    result = tool(p["id"], "book_appointment", {"slot_id": slot_id})
    good = result.startswith("Запись создана")
    # подсказки для модели («называй врача…», «не записывай…») в форме не показываем
    if good:
        message = re.sub(r"appointment_id=\d+:? ?", "", result).split(" Пациенту называй")[0]
    elif "уже занято" in result:
        message = "Это время только что заняли. Выберите другое окно."
    else:
        message = result.split(" Запись не создана")[0].split(" Запись НЕ создана")[0]
    return ok({"ok": good, "message": message})


async def cancel(request):
    p = need_patient(request)
    if not p:
        return patient_only(request)
    try:
        aid = int((await body(request)).get("appointment_id", 0))
    except (TypeError, ValueError):
        return fail("Неверная запись")
    result = tool(p["id"], "cancel_appointment", {"appointment_id": aid})
    return ok({"ok": result.startswith("Запись отменена"), "message": result})


async def review(request):
    p = need_patient(request)
    if not p:
        return patient_only(request)
    data = await body(request)
    try:
        doctor_id, rating = int(data.get("doctor_id", 0)), int(data.get("rating", 0))
    except (TypeError, ValueError):
        return fail("Выберите врача и оценку")
    with connect() as con:
        d = con.execute("SELECT name FROM doctors WHERE id=?", (doctor_id,)).fetchone()
    if not d:
        return fail("Выберите врача")
    result = tool(p["id"], "leave_review", {"doctor": d["name"], "rating": rating, "text": str(data.get("text", ""))[:600]})
    good = result.startswith("Спасибо")
    return ok({"ok": good, "message": result})


# ---------- свои MCP ----------

MCP_PRESETS = [
    {"name": "DeepWiki", "url": "https://mcp.deepwiki.com/mcp", "about": "Вопросы по любому открытому репозиторию GitHub"},
    {"name": "Context7", "url": "https://mcp.context7.com/mcp", "about": "Свежая документация библиотек и фреймворков"},
    {"name": "Microsoft Learn", "url": "https://learn.microsoft.com/api/mcp", "about": "Поиск по документации Microsoft"},
    {"name": "Cloudflare Docs", "url": "https://docs.mcp.cloudflare.com/mcp", "about": "Документация Cloudflare"},
    {"name": "GitMCP Docs", "url": "https://gitmcp.io/docs", "about": "Документация любого проекта на GitHub"},
]


async def mcp_list(request):
    p = need_patient(request)
    if not p:
        return patient_only(request)
    tid = request.query_params.get("thread_id", "")
    servers = []
    if owns(p["id"], tid):
        with connect() as con:
            con.execute(user_mcp.SCHEMA)
            for r in con.execute("SELECT * FROM user_mcp WHERE thread_id=? ORDER BY id", (tid,)):
                try:
                    tools = json.loads(r["tools"]) if r["status"] == "ok" else []
                except ValueError:
                    tools = []
                servers.append({"url": r["url"], "status": r["status"], "at": r["created_at"],
                                "error": None if r["status"] == "ok" else r["tools"], "tools": tools})
    return ok({"enabled": user_mcp.enabled(), "presets": MCP_PRESETS, "servers": servers,
               "limits": {"servers": user_mcp.MAX_SERVERS_PER_THREAD, "tools": user_mcp.MAX_TOOLS_PER_SERVER}})


async def mcp_connect(request):
    p = need_patient(request)
    if not p:
        return patient_only(request)
    data = await body(request)
    tid = str(data.get("thread_id", ""))
    if not owns(p["id"], tid):
        return fail("Это не ваш диалог", 403)
    if limited(f"mcp:{p['id']}", 10, 3600):
        return fail("Слишком много подключений за час", 429)
    url = str(data.get("url", "")).strip()[:300]
    try:
        result = await asyncio.wait_for(user_mcp.connect_server(tid, url), timeout=30)
    except asyncio.TimeoutError:
        result = "Сервер не ответил за 30 секунд."
    log_tool(tid, "connect_mcp_server (кабинет)", {"url": url}, result, True)
    return ok({"ok": result.startswith("Сервер подключён"), "message": result})


# ---------- для прокси чата ----------

async def internal_check(request):
    """Прокси спрашивает: можно ли этому токену работать с этим чатом. Только с ключом из .env."""
    key = env_value("MIS_KEY")
    if not key or not hmac.compare_digest(request.headers.get("x-internal-key", ""), key):
        return fail("forbidden", 403)
    who = need_principal(request)
    tid = request.query_params.get("thread_id", "")
    if not who or not owns(who, tid):
        return fail("forbidden", 403)
    try:  # чат пропал из памяти агента после перезапуска: поднимаем его из журнала
        ensure_thread(tid)
    except Exception as e:
        print(f"[ЧАТ] восстановление {tid}: {e}", flush=True)
    return ok()


VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip() if (ROOT / "VERSION").exists() else "?"


async def health(request):
    return ok({"ok": True, "version": VERSION})


routes = [
    Route("/health", health),
    Route("/auth/request", auth_request, methods=["POST"]),
    Route("/auth/verify", auth_verify, methods=["POST"]),
    Route("/auth/register", auth_register, methods=["POST"]),
    Route("/auth/logout", auth_logout, methods=["POST"]),
    Route("/me", me),
    Route("/threads", threads, methods=["GET", "POST"]),
    Route("/catalog", catalog),
    Route("/slots", slots),
    Route("/book", book, methods=["POST"]),
    Route("/cancel", cancel, methods=["POST"]),
    Route("/review", review, methods=["POST"]),
    Route("/mcp", mcp_list),
    Route("/mcp/connect", mcp_connect, methods=["POST"]),
    Route("/internal/check", internal_check),
]
# on_startup убран в Starlette 1.0, поэтому схему создаём сразу при запуске модуля
ensure_schema()
app = Starlette(routes=routes)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8090, log_level="warning")
