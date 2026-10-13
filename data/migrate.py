"""Обновляет существующую базу clinic.db под новую версию, ничего не стирая (запускает update.sh).
- добавляет новые таблицы и колонки;
- обновляет базу знаний из kb.csv;
- если отзывов нет, загружает стартовые из reviews.csv;
- достраивает расписание врачей на 7 дней вперёд от сегодня.
"""
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load_data import DB, load_staff, read  # noqa: E402

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
con.executescript("""
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, doctor_id INTEGER,
                                    patient_id INTEGER, rating INTEGER, text TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS user_mcp (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, url TEXT, status TEXT, tools TEXT);
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, channel TEXT, recipient TEXT, text TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS code_requests (id INTEGER PRIMARY KEY, created_at TEXT, thread_id TEXT, patient_id INTEGER);
""")
cols = {r[1] for r in con.execute("PRAGMA table_info(patients)")}
for c, t in (("source", "TEXT DEFAULT 'csv'"), ("reg_thread", "TEXT"), ("created_at", "TEXT")):
    if c not in cols:
        con.execute(f"ALTER TABLE patients ADD COLUMN {c} {t}")

for c, t in (("role", "TEXT DEFAULT 'patient'"), ("staff_id", "INTEGER"), ("ctx", "TEXT")):
    if c not in {r[1] for r in con.execute("PRAGMA table_info(sessions)")}:
        con.execute(f"ALTER TABLE sessions ADD COLUMN {c} {t}")
staff = load_staff(con)
try:
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_active_slot ON appointments(slot_id) WHERE status='active'")
except sqlite3.IntegrityError:
    print("ВНИМАНИЕ: в базе есть две активные записи на одно окно, отмени лишнюю в админке (вкладка «Записи»)")

kb = read("kb.csv")
if kb:
    con.execute("DELETE FROM kb")
    for r in kb:
        con.execute("INSERT INTO kb (title, content) VALUES (?,?)", (r["title"], r["content"]))

if con.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 0:
    for r in read("reviews.csv"):
        con.execute("INSERT INTO reviews (created_at, thread_id, doctor_id, patient_id, rating, text, status)"
                    " VALUES (?,?,?,?,?,?,'published')",
                    (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "csv", r["doctor_id"], r["patient_id"],
                     int(r["rating"]), r["text"]))

start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
added = 0
for d in con.execute("SELECT id FROM doctors").fetchall():
    for day in range(7):
        for hour in range(9, 20):
            t = (start + timedelta(days=day, hours=hour)).strftime("%Y-%m-%d %H:%M")
            if not con.execute("SELECT 1 FROM slots WHERE doctor_id=? AND start_at=?", (d["id"], t)).fetchone():
                con.execute("INSERT INTO slots (doctor_id, start_at, is_free) VALUES (?,?,1)", (d["id"], t))
                added += 1
con.commit()
print(f"База обновлена: сотрудников {staff}, статей в базе знаний {len(kb)}, "
      f"отзывов {con.execute('SELECT COUNT(*) FROM reviews').fetchone()[0]}, новых окон в расписании {added}")
con.close()
