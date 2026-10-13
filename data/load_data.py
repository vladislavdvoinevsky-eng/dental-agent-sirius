"""Создаёт data/clinic.db из CSV-файлов в папке data/.
Слоты расписания генерируются автоматически на 7 дней вперёд для каждого врача.
Запуск: python data/load_data.py  (база пересоздаётся заново)
"""
import csv
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

DATA = Path(__file__).resolve().parent
DB = DATA / "clinic.db"

SCHEMA = """
CREATE TABLE branches (id INTEGER PRIMARY KEY, name TEXT, address TEXT);
CREATE TABLE doctors (id INTEGER PRIMARY KEY, name TEXT, specialty TEXT, branch_id INTEGER);
CREATE TABLE slots (id INTEGER PRIMARY KEY, doctor_id INTEGER, start_at TEXT, is_free INTEGER);
CREATE TABLE patients (id INTEGER PRIMARY KEY, full_name TEXT, phone TEXT, birth_date TEXT,
                       email TEXT, telegram_chat_id TEXT, source TEXT DEFAULT 'csv',
                       reg_thread TEXT, created_at TEXT);
CREATE TABLE appointments (id INTEGER PRIMARY KEY, patient_id INTEGER, slot_id INTEGER,
                           status TEXT, created_at TEXT);
CREATE TABLE treatment_plans (id INTEGER PRIMARY KEY, patient_id INTEGER, diagnosis TEXT,
                              plan TEXT, cost INTEGER);
CREATE TABLE kb (id INTEGER PRIMARY KEY, title TEXT, content TEXT);
CREATE TABLE sessions (thread_id TEXT PRIMARY KEY, patient_id INTEGER, pending_patient_id INTEGER,
                       code TEXT, attempts INTEGER DEFAULT 0, updated_at TEXT,
                       role TEXT DEFAULT 'patient', staff_id INTEGER, ctx TEXT);
CREATE TABLE staff (id INTEGER PRIMARY KEY, full_name TEXT, phone TEXT, role TEXT, doctor_id INTEGER);
CREATE UNIQUE INDEX uq_active_slot ON appointments(slot_id) WHERE status='active';
CREATE TABLE outbox (id INTEGER PRIMARY KEY, channel TEXT, recipient TEXT, text TEXT, created_at TEXT);
CREATE TABLE chat_log (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, role TEXT, text TEXT);
CREATE TABLE security_events (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, kind TEXT, detail TEXT);
CREATE TABLE code_requests (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, patient_id INTEGER);
CREATE TABLE reviews (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, doctor_id INTEGER, patient_id INTEGER,
                      rating INTEGER, text TEXT, status TEXT);
CREATE TABLE user_mcp (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, url TEXT, status TEXT, tools TEXT);
CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, tool TEXT, args TEXT,
                         result TEXT, verified INTEGER);
"""


def digits(phone: str) -> str:
    d = "".join(c for c in phone if c.isdigit())
    if len(d) == 11 and d[0] == "8":
        d = "7" + d[1:]
    return d


def norm_date(s: str) -> str:
    """ГГГГ-ММ-ДД из ГГГГ-ММ-ДД, ДД.ММ.ГГГГ или ДД/ММ/ГГГГ (Excel меняет формат дат)."""
    s = (s or "").strip()
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%Y.%m.%d", "%d.%m.%y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return s


def read(name):
    """Читает CSV в UTF-8 или Windows-1251, с разделителем , или ; (так сохраняет Excel)."""
    path = DATA / name
    if not path.exists():
        return []
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1251"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    first = text.splitlines()[0] if text else ""
    delim = ";" if first.count(";") > first.count(",") else ","
    rows = csv.DictReader(text.splitlines(), delimiter=delim)
    return [{(k or "").strip(): (v or "").strip() for k, v in r.items()}
            for r in rows if any((v or "").strip() for v in r.values() if isinstance(v, str))]


def load_staff(con):
    """Сотрудники из staff.csv: врачи (role=doctor, doctor_id из doctors.csv) и администраторы (role=admin).
    Входят в чат по своему телефону и коду, как пациенты, но выбирают роль при входе."""
    con.execute("CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY, full_name TEXT, phone TEXT, role TEXT,"
                " doctor_id INTEGER)")
    rows = read("staff.csv")
    if not rows:
        return 0
    con.execute("DELETE FROM staff")
    for r in rows:
        role = (r.get("role") or "").strip().lower()
        if role not in ("doctor", "admin"):
            print(f"  ВНИМАНИЕ: у сотрудника {r.get('id')} роль «{r.get('role')}». Нужно doctor или admin")
            continue
        ph = digits(r.get("phone", ""))
        if len(ph) != 11:
            print(f"  ВНИМАНИЕ: у сотрудника {r.get('id')} странный телефон «{r.get('phone')}»")
        con.execute("INSERT INTO staff (id, full_name, phone, role, doctor_id) VALUES (?,?,?,?,?)",
                    (r["id"], r["full_name"], ph, role, r.get("doctor_id") or None))
    return len(rows)


def main():
    if DB.exists():
        DB.unlink()
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)

    for r in read("branches.csv"):
        con.execute("INSERT INTO branches VALUES (?,?,?)", (r["id"], r["name"], r["address"]))
    doctors = read("doctors.csv")
    for r in doctors:
        con.execute("INSERT INTO doctors VALUES (?,?,?,?)",
                    (r["id"], r["name"], r["specialty"].strip().lower(), r["branch_id"]))
    for r in read("patients.csv"):
        ph = digits(r["phone"])
        if len(ph) != 11 or "e" in r["phone"].lower() or "," in r["phone"]:
            print(f"  ВНИМАНИЕ: у пациента {r['id']} странный телефон «{r['phone']}». Excel мог испортить номер "
                  "(вид 8,9E+10). Код ему не придёт. Впиши номер как текст, например '89001112233")
        if len(norm_date(r["birth_date"])) != 10 or norm_date(r["birth_date"])[4] != "-":
            print(f"  ВНИМАНИЕ: у пациента {r['id']} непонятная дата рождения «{r['birth_date']}». Нужно ДД.ММ.ГГГГ")
        con.execute("INSERT INTO patients (id, full_name, phone, birth_date, email, telegram_chat_id)"
                    " VALUES (?,?,?,?,?,?)",
                    (r["id"], r["full_name"], digits(r["phone"]), norm_date(r["birth_date"]),
                     r.get("email", ""), r.get("telegram_chat_id", "")))
    for r in read("treatment_plans.csv"):
        con.execute("INSERT INTO treatment_plans (patient_id, diagnosis, plan, cost) VALUES (?,?,?,?)",
                    (r["patient_id"], r["diagnosis"], r["plan"], r.get("cost") or 0))
    for r in read("reviews.csv"):
        con.execute("INSERT INTO reviews (created_at, thread_id, doctor_id, patient_id, rating, text, status)"
                    " VALUES (?,?,?,?,?,?,'published')",
                    (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "csv", r["doctor_id"], r["patient_id"],
                     int(r["rating"]), r["text"]))
    for r in read("kb.csv"):
        con.execute("INSERT INTO kb (title, content) VALUES (?,?)", (r["title"], r["content"]))
    load_staff(con)

    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    n = 0
    for d in doctors:
        for day in range(7):
            for hour in range(9, 20):
                t = start + timedelta(days=day, hours=hour)
                con.execute("INSERT INTO slots (doctor_id, start_at, is_free) VALUES (?,?,1)",
                            (d["id"], t.strftime("%Y-%m-%d %H:%M")))
                n += 1
    con.commit()
    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ["branches", "doctors", "staff", "patients", "treatment_plans", "kb", "reviews", "slots"]}
    con.close()
    print("База создана:", DB)
    for t, c in counts.items():
        print(f"  {t}: {c}")
    if counts["doctors"] == 0 or counts["patients"] == 0:
        print("  Внимание: заполни data/doctors.csv и data/patients.csv и запусти скрипт ещё раз")


if __name__ == "__main__":
    main()
