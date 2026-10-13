"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, ClipboardList, LoaderCircle, Lock, Stethoscope, UserRound, type LucideIcon } from "lucide-react";
import { ApiError, Patient, Role, useAuth } from "./auth";
import { BrandTile } from "./brand";
import { GhostButton, Modal, Notice, PrimaryButton } from "./ui";

/* Вход до начала чата: телефон -> код -> (для нового номера) ФИО.
   Код получает не собеседник, а администратор клиники (админка, окно терминала с run.sh, Telegram):
   он сам решает, кому его назвать. Поэтому чужой номер ввести можно, а войти по нему — нет. */

function formatPhone(digits: string) {
  const d = digits.replace(/\D/g, "").replace(/^8/, "7").replace(/^([^7])/, "7$1").slice(0, 11);
  const p = d.slice(1);
  let out = "+7";
  if (p.length) out += " " + p.slice(0, 3);
  if (p.length > 3) out += " " + p.slice(3, 6);
  if (p.length > 6) out += "-" + p.slice(6, 8);
  if (p.length > 8) out += "-" + p.slice(8, 10);
  return out;
}

const ROLE_CARDS: { role: Role; icon: LucideIcon; title: string; hint: string }[] = [
  { role: "patient", icon: UserRound, title: "Пациент", hint: "Записаться, мои записи, план лечения" },
  { role: "doctor", icon: Stethoscope, title: "Врач", hint: "Моё расписание, карточки моих пациентов" },
  { role: "admin", icon: ClipboardList, title: "Администратор", hint: "Регистратура: записи всех врачей" },
];

const inputCls =
  "border-input bg-sheet focus:border-ink/50 focus:shadow-[0_0_0_4px_var(--track)] h-12 w-full rounded-2xl border px-4 text-[17px] outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70";

export function LoginDialog({ onThread }: { onThread: (threadId: string) => void }) {
  const auth = useAuth();
  const open = auth.status === "guest" || auth.status === "need_name";
  const [step, setStep] = useState<"role" | "phone" | "code">("role");
  const [role, setRole] = useState<Role>("patient");
  const [hint, setHint] = useState("");
  const [phone, setPhone] = useState("+7 ");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [demoCode, setDemoCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState("");
  useEffect(() => {
    fetch("/gw/health")
      .then((r) => r.json())
      .then((d) => setVersion(d.version || ""))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!wait) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  useEffect(() => {
    if (step === "code") setTimeout(() => codeRef.current?.focus(), 50);
  }, [step]);

  // После выхода начинаем с выбора роли
  useEffect(() => {
    if (auth.status === "guest") {
      setStep("role");
      setCode("");
      setHint("");
      setDemoCode("");
    }
  }, [auth.status]);

  const digits = phone.replace(/\D/g, "");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Нет связи с клиникой, попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  };

  const requestCode = (e?: FormEvent) => {
    e?.preventDefault();
    if (digits.length !== 11) return setError("Введите номер полностью");
    run(async () => {
      const r = await auth.api<{ sent: boolean; demo_code?: string; demo_hint?: string }>("auth/request", {
        body: { phone: digits, role },
      });
      setDemoCode(r.demo_code || "");
      setHint(r.demo_hint || "");
      setCode("");
      setStep("code");
      setWait(30);
    });
  };

  const verify = (e?: FormEvent, value = code) => {
    e?.preventDefault();
    if (value.length !== 6) return;
    run(async () => {
      const r = await auth.api<{ token: string; need_name: boolean; patient?: Patient; thread_id?: string }>(
        "auth/verify",
        { body: { phone: digits, code: value, role } },
      );
      auth.signedIn(r);
      if (r.thread_id) onThread(r.thread_id);
    });
  };

  const register = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await auth.api<{ patient: Patient; thread_id: string }>("auth/register", {
        body: { full_name: name },
      });
      auth.registered(r.patient);
      onThread(r.thread_id);
    });
  };

  if (auth.status === "loading") return null;

  return (
    <Modal
      open={open}
      dismissible={false}
      title="Вход в чат клиники"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {step !== "role" && auth.status === "guest" ? (
            <button
              type="button"
              onClick={() => {
                setError("");
                setStep(step === "code" ? "phone" : "role");
              }}
              className="hover:bg-secondary -ml-1 grid size-9 cursor-pointer place-items-center rounded-full"
              aria-label="Назад"
            >
              <ArrowLeft className="size-[18px]" />
            </button>
          ) : (
            <BrandTile size={40} />
          )}
          <div>
            <div className="text-[19px] leading-tight font-semibold">
              {auth.status === "need_name"
                ? "Давайте познакомимся"
                : step === "role"
                  ? "Вход в чат клиники"
                  : step === "phone"
                    ? `Вход: ${ROLE_CARDS.find((c) => c.role === role)?.title.toLowerCase()}`
                    : "Введите код"}
            </div>
            <div className="text-muted-foreground text-[13px]">
              {auth.status === "need_name"
                ? "Номер подтверждён. Как к вам обращаться?"
                : step === "role"
                  ? "Кто вы? От этого зависит, что умеет чат"
                  : step === "phone"
                    ? role === "patient"
                      ? "Чтобы записаться и видеть свои записи"
                      : "Номер сотрудника из списка клиники"
                    : `Отправили код для ${phone}`}
            </div>
          </div>
        </div>

        {auth.status === "need_name" ? (
          <form
            onSubmit={register}
            className="flex flex-col gap-3"
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Иванов Иван Иванович"
              autoComplete="name"
              maxLength={80}
              className={inputCls}
            />
            {error && <Notice tone="bad">{error}</Notice>}
            <PrimaryButton
              type="submit"
              disabled={busy || name.trim().split(/\s+/).length < 2}
            >
              {busy && <LoaderCircle className="size-4 animate-spin" />}
              Начать чат
            </PrimaryButton>
            <GhostButton onClick={() => auth.logout()}>Войти с другим номером</GhostButton>
          </form>
        ) : step === "role" ? (
          <div className="flex flex-col gap-2">
            {ROLE_CARDS.map((c) => (
              <button
                key={c.role}
                type="button"
                onClick={() => {
                  setRole(c.role);
                  setError("");
                  setStep("phone");
                }}
                className="group border-border hover:border-input hover:bg-secondary flex cursor-pointer items-center gap-3 rounded-2xl border p-3 text-left transition-colors"
              >
                <span className="bg-tile group-hover:bg-ink group-hover:text-on-ink grid size-10 flex-none place-items-center rounded-xl transition-colors">
                  <c.icon className="size-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold">{c.title}</span>
                  <span className="text-muted-foreground block text-[12.5px]">{c.hint}</span>
                </span>
                <ChevronRight className="text-muted-foreground size-4" />
              </button>
            ))}
            <p className="text-muted-foreground mt-1 flex gap-2 text-[12.5px] leading-snug">
              <Lock className="mt-0.5 size-3.5 flex-none" />
              Роль проверяется по номеру: врачом или администратором можно войти только с номера сотрудника.
            </p>
            {version && <p className="text-muted-foreground/70 text-center text-[11px]">Версия {version}</p>}
          </div>
        ) : step === "phone" ? (
          <form
            onSubmit={requestCode}
            className="flex flex-col gap-3"
          >
            <input
              autoFocus
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(formatPhone(e.target.value))}
              placeholder="+7 900 000-00-00"
              aria-label="Номер телефона"
              className={inputCls + " tabular-nums"}
            />
            {error && <Notice tone="bad">{error}</Notice>}
            <PrimaryButton
              type="submit"
              disabled={busy || digits.length !== 11}
            >
              {busy && <LoaderCircle className="size-4 animate-spin" />}
              Получить код
            </PrimaryButton>
            <p className="text-muted-foreground flex gap-2 text-[12.5px] leading-snug">
              <Lock className="mt-0.5 size-3.5 flex-none" />
              Код получит администратор клиники и назовёт его вам. Так никто не войдёт под чужим номером.
            </p>
          </form>
        ) : (
          <form
            onSubmit={verify}
            className="flex flex-col gap-3"
          >
            <input
              ref={codeRef}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(v);
                if (v.length === 6) verify(undefined, v);
              }}
              placeholder="••••••"
              aria-label="Код из 6 цифр"
              className={inputCls + " text-center text-[26px] font-semibold tracking-[0.5em] tabular-nums"}
            />
            {demoCode && (
              <Notice tone="warn">
                Демо-режим: код <b className="tabular-nums">{demoCode}</b>.{" "}
                <button
                  type="button"
                  className="cursor-pointer underline underline-offset-2"
                  onClick={() => {
                    setCode(demoCode);
                    verify(undefined, demoCode);
                  }}
                >
                  Подставить
                </button>
              </Notice>
            )}
            {hint && <Notice tone="warn">{hint}</Notice>}
            {!demoCode && !hint && <Notice>Код показан администратору клиники. Попросите его назвать код.</Notice>}
            {error && <Notice tone="bad">{error}</Notice>}
            <PrimaryButton
              type="submit"
              disabled={busy || code.length !== 6}
            >
              {busy && <LoaderCircle className="size-4 animate-spin" />}
              Войти
            </PrimaryButton>
            <button
              type="button"
              disabled={wait > 0 || busy}
              onClick={() => requestCode()}
              className="text-muted-foreground hover:text-foreground cursor-pointer text-[13px] disabled:cursor-default disabled:opacity-60"
            >
              {wait > 0 ? `Отправить код ещё раз через ${wait} с` : "Отправить код ещё раз"}
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}
