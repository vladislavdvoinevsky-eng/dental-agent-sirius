"""Сценарии записи. Запуск из папки агента: .venv/bin/python tests/test_booking.py
Работает на ВРЕМЕННОЙ базе, настоящую data/clinic.db не трогает."""
import sys, threading, sqlite3, json, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "data"))
from datetime import datetime, timedelta
TMP = Path(tempfile.mkdtemp()) / "clinic_test.db"
import load_data
load_data.DB = TMP
load_data.main()
import agent.db
agent.db.DB = TMP
agent.db.ensure_log_tables()
from agent.db import connect, save_session, get_ctx
from agent import tools as T
R = lambda name, args, tid: T.run_local_tool(name, args, tid)
ok = fail = 0
def check(title, cond, info=""):
    global ok, fail
    if cond: ok += 1; print("  ✓", title)
    else: fail += 1; print("  ✗", title, "|", info)
def reset():
    with connect() as con:
        con.execute("DELETE FROM appointments"); con.execute("UPDATE slots SET is_free=1")
for t, pid in (("A", 1), ("B", 2), ("C", 3)): save_session(t, patient_id=pid, role="patient")
save_session("ADM", role="admin", staff_id=4)
with connect() as con:
    first = con.execute("SELECT MIN(substr(start_at,1,10)) FROM slots").fetchone()[0]
D, D2 = first, (datetime.strptime(first, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
def active(pid):
    with connect() as con:
        return con.execute("SELECT a.id, d.name, s.start_at FROM appointments a JOIN slots s ON s.id=a.slot_id JOIN doctors d ON d.id=s.doctor_id WHERE a.patient_id=? AND a.status='active'", (pid,)).fetchall()
def slot(doc_id, date, tm):
    with connect() as con:
        return con.execute("SELECT id FROM slots WHERE doctor_id=? AND start_at=?", (doc_id, f"{date} {tm}")).fetchone()[0]

print("1. Поиск врача в любом падеже")
with connect() as con:
    for q, want in (("Илье Андреевичу", "Смирнов"), ("к Волковой", "Волкова"), ("Кузнецовой", "Кузнецова"),
                    ("Анне Сергеевне", "Волкова"), ("хирургу", "Смирнов"), ("Смирнов", "Смирнов"), ("ортодонт", "Кузнецова")):
        d = T._find_doctor(con, q); check(f"«{q}» → {want}", d and want in d["name"], d and d["name"])

print("2. Твой случай: Иван записался формой к Смирнову, Тест просит то же время в чате")
reset()
r1 = R("book_appointment", {"slot_id": slot(2, D, "09:00")}, "A")
check("форма: Иван записан к Смирнову", r1.startswith("Запись создана") and "Смирнов" in r1, r1)
r2 = R("book_appointment", {"doctor": "Илье Андреевичу", "date": D, "time": "09:00"}, "B")
check("чат: Тесту отказ «занято», запись не создана", "уже занято" in r2 and not active(2), r2)
r3 = R("book_appointment", {"doctor": "Смирнов", "date": D, "time": "09:00", "slot_id": slot(1, D, "09:00")}, "B")
check("модель подсунула окно Волковой с doctor=Смирнов: отказ", "принадлежит врачу" in r3 and not active(2), r3)
r4 = R("book_appointment", {"slot_id": slot(2, D, "10:00"), "date": D, "time": "09:00"}, "B")
check("slot_id на 10:00, а пациент просил 09:00: отказ", "а не на" in r4 and not active(2), r4)
r5 = R("book_appointment", {"doctor": "Смирнов", "date": D, "time": "10:00"}, "B")
check("другое время у Смирнова: записан, ответ называет Смирнова", r5.startswith("Запись создана") and "Смирнов" in r5 and "10:00" in r5, r5)

print("3. Подтверждение после записи через форму (без номера записи)")
r = R("send_message", {"channel": "telegram", "template": "confirmation"}, "A")
check("send_message без appointment_id находит ближайшую запись", r.startswith("Сообщение"), r)
r = R("send_message", {"channel": "telegram", "template": "confirmation", "appointment_id": 9999}, "A")
check("чужой/неверный номер: список своих записей, без отправки", "Записи с номером" in r, r)

print("4. Один пациент, одно время, разные врачи")
r = R("book_appointment", {"doctor": "Волкова", "date": D, "time": "09:00"}, "A")
check("Иван не может к Волковой на то же 09:00", "уже есть запись" in r, r)

print("5. Лимит записей считает только будущие")
reset()
with connect() as con:
    past = con.execute("SELECT id FROM slots LIMIT 2").fetchall()
    for x in past:
        con.execute("INSERT INTO appointments (patient_id, slot_id, status, created_at) VALUES (3, ?, 'active', '2026-01-01')", (x[0],))
    con.execute("UPDATE slots SET start_at='2026-01-0'||id||' 09:00' WHERE id IN (?,?)", (past[0][0], past[1][0]))
r = R("book_appointment", {"doctor": "Кузнецова", "date": D2, "time": "12:00"}, "C")
check("2 прошедших визита не мешают новой записи", r.startswith("Запись создана"), r)
R("book_appointment", {"doctor": "Кузнецова", "date": D2, "time": "13:00"}, "C")
r = R("book_appointment", {"doctor": "Кузнецова", "date": D2, "time": "14:00"}, "C")
check("третья предстоящая запись: отказ по лимиту", "больше 2 нельзя" in r, r)
with connect() as con:  # вернуть прошлые окна на место
    con.execute("DELETE FROM appointments WHERE patient_id=3")

print("6. Отмена и перенос без номера")
reset()
R("book_appointment", {"doctor": "Волкова", "date": D2, "time": "11:00"}, "B")
r = R("reschedule_appointment", {"doctor": "Волкова", "date": D2, "time": "12:00"}, "B")
check("перенос единственной записи без номера", "перенесена" in r and "12:00" in r, r)
with connect() as con:
    freed = con.execute("SELECT is_free FROM slots WHERE id=?", (slot(1, D2, "11:00"),)).fetchone()[0]
check("старое окно освободилось", freed == 1)
r = R("reschedule_appointment", {"doctor": "Волкова", "date": D2, "time": "12:00"}, "B")
check("перенос на то же время: понятный ответ", "уже стоит" in r, r)
R("book_appointment", {"doctor": "Смирнов", "date": D2, "time": "15:00"}, "A")
r = R("reschedule_appointment", {"doctor": "Смирнов", "date": D2, "time": "15:00"}, "B")
check("перенос на занятое другим окно: отказ, запись не тронута", "уже занято" in r and active(2)[0][2].endswith("12:00"), r)
R("book_appointment", {"doctor": "Кузнецова", "date": D2, "time": "16:00"}, "B")
r = R("cancel_appointment", {}, "B")
check("две записи и отмена без номера: просит уточнить", "несколько записей" in r and len(active(2)) == 2, r)
aid = active(2)[0][0]
r = R("cancel_appointment", {"appointment_id": aid}, "B")
check("отмена по номеру называет, что отменено", r.startswith("Запись отменена:"), r)
r = R("book_appointment", {"doctor": "Волкова", "date": D2, "time": "12:00"}, "C")
check("освобождённое отменой окно можно занять снова", r.startswith("Запись создана"), r)

print("7. Одновременная запись 3 пациентов на одно окно, 20 раз")
good = True
for i in range(20):
    reset(); res = {}; b = threading.Barrier(3)
    def go(t):
        b.wait(); res[t] = R("book_appointment", {"doctor": "Смирнов", "date": D2, "time": "09:00"}, t)
    th = [threading.Thread(target=go, args=(t,)) for t in "ABC"]; [x.start() for x in th]; [x.join() for x in th]
    n = sum(v.startswith("Запись создана") for v in res.values())
    with connect() as con:
        cnt = con.execute("SELECT COUNT(*) FROM appointments WHERE status='active'").fetchone()[0]
    if n != 1 or cnt != 1: good = False; print(res)
check("всегда ровно одна запись, двое получают «занято»", good)

print("8. Администратор")
reset()
r = R("book_for_patient", {"patient_id": 1, "doctor": "Смирнов", "date": D2, "time": "10:00"}, "ADM")
check("админ записал пациента, ответ называет врача", r.startswith("Запись создана") and "Смирнов" in r, r)
r = R("book_for_patient", {"patient_id": 2, "doctor": "Смирнов", "date": D2, "time": "10:00"}, "ADM")
check("админ на занятое окно: отказ", "уже занято" in r, r)
r = R("book_appointment", {"doctor": "Смирнов", "date": D2, "time": "10:00"}, "B")
check("пациент в чате на окно, занятое админом: отказ", "уже занято" in r, r)

print("9. Прошедшее время и мусор")
with connect() as con:
    old = con.execute("SELECT id FROM slots ORDER BY start_at LIMIT 1").fetchone()[0]
    con.execute("UPDATE slots SET start_at='2020-01-01 09:00' WHERE id=?", (old,))
r = R("book_appointment", {"slot_id": old}, "B")
check("окно в прошлом: отказ", "недоступен" in r, r)
r = R("book_appointment", {"doctor": "Пупкин", "date": D2, "time": "10:00"}, "B")
check("несуществующий врач: отказ", "нет" in r and "не создана" in r, r)
r = R("book_appointment", {"doctor": "Смирнов", "date": D2, "time": "08:00"}, "B")
check("время вне расписания: отказ", "нет приёма" in r, r)
r = R("book_appointment", {}, "B")
check("пустой вызов: просит врача, дату, время", "укажи врача" in r, r)
print(f"\nИтого: {ok} прошло, {fail} упало")
