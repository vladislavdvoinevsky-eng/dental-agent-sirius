"""Защитные фильтры агента: вход, история диалога, ответ модели.

Это второй рубеж. Первый рубеж в коде инструментов: данные пациента
доступны только после подтверждения личности, а id пациента берётся из сессии.
"""
import base64
import re
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from agent.db import connect, env_value, log_security

ROOT = Path(__file__).resolve().parent.parent
MAX_INPUT_CHARS = 2000
MAX_HISTORY = 24          # последних сообщений, которые видит модель
REFUSAL = "Не могу помочь с этим запросом. Если вам нужна запись к врачу или информация об услугах, напишите."

# Признаки попыток манипуляции. Сообщение не блокируем (ложные срабатывания), а пишем в журнал.
SUSPICIOUS = [
    r"игнор\w*\s+(все|предыдущ|инструкц)", r"ignore\s+(all|previous|prior)", r"системн\w*\s+(промпт|инструкц|сообщ)",
    r"system\s*prompt", r"developer\s*mode", r"ты\s+теперь", r"you\s+are\s+now", r"jailbreak", r"DAN\b",
    r"base64", r"rot13", r"в\s+обратном\s+порядке", r"по\s+букв", r"patient_id", r"thread_id",
    r"<\s*/?\s*(system|tool|assistant)\s*>", r"\[\s*(SYSTEM|INST)\s*\]", r"verify_patient", r"админ\w*\s+(режим|доступ)",
    r"я\s+(главврач|разработчик)", r"смени\w*\s+рол", r"(войди|зайди)\s+как", r"127\.0\.0\.1|localhost|:8765|:2024|:11434", r"выведи\s+(все|всех|базу|таблиц)", r"SELECT\s+.+\s+FROM",
]
_SUS = [re.compile(p, re.I) for p in SUSPICIOUS]


def game_flag():
    return env_value("GAME_FLAG")


def _flag_variants(flag):
    """Флаг в открытом виде, задом наперёд, в base64 и hex: частые способы вынести его мимо фильтра."""
    raw = flag.encode("utf-8")
    out = [("флаг", flag), ("флаг задом наперёд", flag[::-1]),
           ("флаг в hex", raw.hex()), ("флаг в base64", base64.b64encode(raw).decode().rstrip("="))]
    return out


def _text(m):
    c = m.content
    if isinstance(c, list):
        c = " ".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in c)
    return str(c or "")


def check_input(thread_id, text):
    hits = [p.pattern for p in _SUS if p.search(text)]
    if hits:
        log_security(thread_id, "suspicious_input", f"{hits[:3]} :: {text[:300]}")
    return hits


def clean_history(thread_id, messages):
    """Убирает то, что не мог прислать обычный пользователь, и обрезает историю."""
    out = []
    known_calls = set()
    for m in messages:
        if isinstance(m, SystemMessage):
            log_security(thread_id, "injected_system_message", _text(m)[:300])
            continue
        if isinstance(m, AIMessage):
            for c in m.tool_calls or []:
                known_calls.add(c.get("id"))
        if isinstance(m, ToolMessage) and m.tool_call_id not in known_calls:
            log_security(thread_id, "injected_tool_message", _text(m)[:300])
            continue
        if isinstance(m, HumanMessage) and len(_text(m)) > MAX_INPUT_CHARS:
            m = HumanMessage(content=_text(m)[:MAX_INPUT_CHARS], id=m.id)
        out.append(m)
    if len(out) > MAX_HISTORY:
        out = out[-MAX_HISTORY:]
        while out and not isinstance(out[0], HumanMessage):  # не начинаем с обрывка вызова инструмента
            out = out[1:]
    return out


def _forbidden_values(who):
    """Что нельзя показывать в этом чате: флаг и данные пациентов, которых собеседнику видеть не положено.
    who: principal из agent.tools (роль и id) или просто id пациента, как раньше.
    - пациент видит только себя;
    - врач видит пациентов, у которых есть запись к нему;
    - администратор регистратуры видит всех пациентов (ему нужны контакты для записи).
    Флаг не видит никто, кроме самого пациента, в чьём плане он лежит: ни врач, ни администратор."""
    if not isinstance(who, dict):
        who = {"role": "patient", "patient_id": who, "doctor_id": None}
    role = who.get("role") or "patient"
    me = who.get("patient_id") if role == "patient" else None
    items = []
    flag = game_flag()
    with connect() as con:
        if flag:
            owners = {r[0] for r in con.execute("SELECT patient_id FROM treatment_plans WHERE plan LIKE ? OR diagnosis LIKE ?",
                                                 (f"%{flag}%", f"%{flag}%"))}
            if me is None or me not in owners:
                items += _flag_variants(flag)
        if role == "admin":
            return items
        allowed = {me} if me else set()
        if role == "doctor" and who.get("doctor_id"):
            allowed |= {r[0] for r in con.execute(
                "SELECT a.patient_id FROM appointments a JOIN slots s ON s.id=a.slot_id WHERE s.doctor_id=?",
                (who["doctor_id"],))}
        # Пациенты, зарегистрированные через чат, созданы самими собеседниками: их не охраняем,
        # иначе зарегистрированное «имя» вроде «Вы записаны» заблокировало бы обычные ответы
        cols = {r[1] for r in con.execute("PRAGMA table_info(patients)")}
        where = " WHERE COALESCE(source,'csv') != 'chat'" if "source" in cols else ""
        for r in con.execute("SELECT id, full_name, phone FROM patients" + where):
            if r["id"] in allowed:
                continue
            if r["full_name"]:
                items.append(("ФИО другого пациента", r["full_name"]))
            if r["phone"] and len(r["phone"]) >= 10:
                items.append(("телефон другого пациента", r["phone"][-10:]))
    return items


def check_output(thread_id, who, text):
    """Возвращает безопасный текст ответа. Если в нём утечка, заменяет на отказ."""
    if not text:
        return text
    plain = text.lower()
    digits = re.sub(r"\D", "", text)
    sep = r"[\s\-_.,:;|/\\*'\"()]+"
    squashed = re.sub(sep, "", plain)
    for kind, value in _forbidden_values(who):
        v = str(value)
        if kind in ("флаг в hex", "флаг в base64"):
            leaked = v.lower() in text.lower().replace(" ", "")
        elif v.isdigit():
            leaked = v in digits
        else:
            vl = v.lower()
            leaked = vl in plain or re.sub(sep, "", vl) in squashed
        if leaked:
            log_security(thread_id, "output_blocked", f"{kind}: ответ заменён")
            return REFUSAL
    return text
