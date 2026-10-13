"""Добавляет одного пациента в существующую базу clinic.db, ничего не стирая.
Запуск через add_patient.sh. Можно сразу задать и план лечения.
"""
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

DB = Path(__file__).resolve().parent / "clinic.db"


def digits(phone: str) -> str:
    d = "".join(c for c in phone if c.isdigit())
    if len(d) == 11 and d[0] == "8":
        d = "7" + d[1:]
    return d


def norm_date(s: str) -> str:
    s = (s or "").strip()
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%d.%m.%y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return ""


def ask(label, required=True):
    while True:
        v = input(label).strip()
        if v or not required:
            return v
        print("  Это поле обязательно, попробуйте ещё раз.")


def main():
    if not DB.exists():
        print("База не найдена. Сначала запустите run.sh или reload_data.sh.")
        return
    print("=== Добавление пациента ===\n")
    name = ask("ФИО: ")
    phone = digits(ask("Телефон: "))
    while True:
        birth = norm_date(ask("Дата рождения (ДД.ММ.ГГГГ): "))
        if birth:
            break
        print("  Непонятный формат даты. Пример: 15.03.1995")
    email = ask("Email (можно пусто): ", required=False)
    tg = ask("Telegram chat_id (можно пусто): ", required=False)

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    dup = con.execute("SELECT id FROM patients WHERE phone=? AND birth_date=?", (phone, birth)).fetchone()
    if dup:
        print(f"\nТакой пациент уже есть (id={dup['id']}). Новый не добавлен.")
        con.close()
        return
    nid = (con.execute("SELECT MAX(id) FROM patients").fetchone()[0] or 0) + 1
    cols = {r[1] for r in con.execute("PRAGMA table_info(patients)")}
    if "source" in cols:
        con.execute("INSERT INTO patients (id, full_name, phone, birth_date, email, telegram_chat_id, source)"
                    " VALUES (?,?,?,?,?,?,'admin')", (nid, name, phone, birth, email, tg))
    else:
        con.execute("INSERT INTO patients (id, full_name, phone, birth_date, email, telegram_chat_id)"
                    " VALUES (?,?,?,?,?,?)", (nid, name, phone, birth, email, tg))

    print("\nДобавить план лечения этому пациенту? (можно оставить пустым)")
    diag = ask("  Диагноз (можно пусто): ", required=False)
    if diag:
        plan = ask("  План лечения: ", required=False)
        cost = ask("  Стоимость, число (можно пусто): ", required=False)
        cost = "".join(c for c in cost if c.isdigit()) or "0"
        con.execute("INSERT INTO treatment_plans (patient_id, diagnosis, plan, cost) VALUES (?,?,?,?)",
                    (nid, diag, plan, int(cost)))
    con.commit()
    con.close()
    print(f"\nГотово. Пациент добавлен, id={nid}, телефон +{phone}, дата {birth}.")
    print("Записи и журналы не тронуты. Перезапускать ничего не нужно.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nОтменено.")
