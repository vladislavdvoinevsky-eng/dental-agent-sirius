import sqlite3
from datetime import datetime
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "clinic.db"

LOG_SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_log (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT,
                                     role TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT,
                                            kind TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS code_requests (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT,
                                          patient_id INTEGER);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, doctor_id INTEGER,
                                    patient_id INTEGER, rating INTEGER, text TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS user_mcp (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, url TEXT,
                                     status TEXT, tools TEXT);
CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT,
                                       tool TEXT, args TEXT, result TEXT, verified INTEGER);
CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY, full_name TEXT, phone TEXT, role TEXT, doctor_id INTEGER);
"""

# Роль собеседника в чате: patient (пациент), doctor (врач), admin (администратор регистратуры).
# Роль и id ставит только шлюз при входе по коду, модель их не видит и поменять не может.
ROLES = {"patient": "Пациент", "doctor": "Врач", "admin": "Администратор"}
SESSION_COLUMNS = [("role", "TEXT DEFAULT 'patient'"), ("staff_id", "INTEGER"), ("ctx", "TEXT")]
# Одно окно врача = не больше одной активной записи. Это проверяет сама база, поэтому два пациента,
# нажавшие «записаться» в одну секунду, не попадут на одно время, даже если проверка в коде пропустит
UNIQUE_SLOT = "CREATE UNIQUE INDEX IF NOT EXISTS uq_active_slot ON appointments(slot_id) WHERE status='active'"


def add_columns(con, table, columns):
    have = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
    if not have:
        return
    for name, decl in columns:
        if name not in have:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def connect():
    con = sqlite3.connect(DB, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def ensure_log_tables():
    if DB.exists():
        with connect() as con:
            con.executescript(LOG_SCHEMA)
            # старые базы: откуда взялся пациент (csv, admin, chat) и из какого чата зарегистрирован
            cols = {r[1] for r in con.execute("PRAGMA table_info(patients)")}
            if cols and "source" not in cols:
                con.execute("ALTER TABLE patients ADD COLUMN source TEXT DEFAULT 'csv'")
            if cols and "reg_thread" not in cols:
                con.execute("ALTER TABLE patients ADD COLUMN reg_thread TEXT")
            if cols and "created_at" not in cols:
                con.execute("ALTER TABLE patients ADD COLUMN created_at TEXT")
            add_columns(con, "sessions", SESSION_COLUMNS)
            try:
                con.execute(UNIQUE_SLOT)
            except sqlite3.IntegrityError:
                print("[БАЗА] ВНИМАНИЕ: в базе уже есть две активные записи на одно окно. Отмени лишнюю в админке "
                      "(вкладка «Записи»), затем перезапусти run.sh", flush=True)


def log_chat(thread_id, role, text):
    try:
        with connect() as con:
            con.execute("INSERT INTO chat_log (created_at, thread_id, role, text) VALUES (?,?,?,?)",
                        (now(), thread_id, role, str(text)[:4000]))
    except Exception as e:
        print(f"[LOG] ошибка записи диалога: {e}", flush=True)


def log_tool(thread_id, tool, args, result, verified):
    try:
        with connect() as con:
            con.execute("INSERT INTO tool_calls (created_at, thread_id, tool, args, result, verified)"
                        " VALUES (?,?,?,?,?,?)",
                        (now(), thread_id, tool, str(args)[:2000], str(result)[:4000], int(bool(verified))))
    except Exception as e:
        print(f"[LOG] ошибка записи вызова: {e}", flush=True)


def log_security(thread_id, kind, detail):
    print(f"[SECURITY] {kind} {thread_id}: {str(detail)[:200]}", flush=True)
    try:
        with connect() as con:
            con.execute("INSERT INTO security_events (created_at, thread_id, kind, detail) VALUES (?,?,?,?)",
                        (now(), thread_id, kind, str(detail)[:2000]))
    except Exception as e:
        print(f"[LOG] ошибка записи события: {e}", flush=True)


def env_value(name, default=""):
    """Значение из .env, читается при каждом вызове: так переключатели из админки работают без перезапуска."""
    import os
    env = DB.parent.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8", errors="ignore").splitlines():
            # первая непустая: пустая строка из .env.example («MIS_KEY=») не перекрывает ключ ниже
            if line.strip().startswith(name + "=") and line.split("=", 1)[1].strip():
                return line.split("=", 1)[1].strip()
    return os.getenv(name, default).strip()


def get_session(thread_id):
    with connect() as con:
        row = con.execute("SELECT * FROM sessions WHERE thread_id=?", (thread_id,)).fetchone()
        return dict(row) if row else {}


def save_session(thread_id, **fields):
    """Обновляет сессию чата, не трогая остальные колонки (роль, контекст)."""
    s = get_session(thread_id)
    s.update(fields)
    s["thread_id"], s["updated_at"] = thread_id, now()
    with connect() as con:
        cols = [r[1] for r in con.execute("PRAGMA table_info(sessions)") if r[1] in s]
        con.execute(f"INSERT OR REPLACE INTO sessions ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                    [s[c] for c in cols])


def get_ctx(thread_id):
    """Короткая память чата, которую ведёт код: например, о каком враче говорили последним."""
    import json
    try:
        return json.loads(get_session(thread_id).get("ctx") or "{}")
    except ValueError:
        return {}


def set_ctx(thread_id, **values):
    import json
    ctx = get_ctx(thread_id)
    ctx.update(values)
    if get_session(thread_id):
        save_session(thread_id, ctx=json.dumps(ctx, ensure_ascii=False))


ensure_log_tables()
