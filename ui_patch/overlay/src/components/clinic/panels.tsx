"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CalendarCheck,
  CalendarX,
  Check,
  LoaderCircle,
  MapPin,
  MessageSquare,
  Plug,
  ShieldCheck,
  SquarePen,
  Star,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ApiError, PanelName, useAuth } from "./auth";
import { Chip, GhostButton, Label, Notice, Panel, PrimaryButton, Stars } from "./ui";

type Service = { name: string; specialty: string; price: string; minutes: string; hint: string; available: boolean };
type Doctor = { id: number; name: string; specialty: string; branch_id: number; branch: string; rating: number | null; reviews: number };
type Branch = { id: number; name: string; address: string };
type Catalog = { services: Service[]; doctors: Doctor[]; branches: Branch[] };
type Slot = { id: number; start_at: string; when: string; doctor: string; doctor_id: number; specialty: string; branch: string };
type Appointment = { id: number; when: string; start_at: string; doctor: string; doctor_id: number; specialty: string; branch: string; status: string };

const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

function dayLabel(date: string) {
  const d = new Date(date + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (diff === 0) return `Сегодня, ${base}`;
  if (diff === 1) return `Завтра, ${base}`;
  return `${WD[d.getDay()]}, ${base}`;
}

function useCatalog(open: boolean) {
  const { api } = useAuth();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    if (open && !catalog) api<Catalog>("catalog").then(setCatalog).catch(() => toast.error("Не загрузился список услуг"));
  }, [open, catalog, api]);
  return catalog;
}

function Section({ n, title, children, done }: { n: number; title: string; children: React.ReactNode; done?: boolean }) {
  return (
    <section className="msg-in mb-5">
      <div className="mb-2.5 flex items-center gap-2">
        <span
          className={cn(
            "grid size-6 place-items-center rounded-lg text-[12px] font-bold",
            done ? "bg-ok-tint text-ok" : "bg-ink text-on-ink",
          )}
        >
          {done ? <Check className="size-3.5" /> : n}
        </span>
        <span className="text-[14.5px] font-semibold">{title}</span>
      </div>
      {children}
    </section>
  );
}

function RatingLine({ d }: { d: Doctor }) {
  if (!d.rating) return <span className="text-muted-foreground">отзывов пока нет</span>;
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1">
      <Star className="size-3.5 fill-[#e3a52a] text-[#e3a52a]" />
      {d.rating} · {d.reviews} {d.reviews === 1 ? "отзыв" : d.reviews < 5 ? "отзыва" : "отзывов"}
    </span>
  );
}

/* ---------- Запись: услуга -> филиал -> врач -> день -> время ---------- */

export function BookPanel({ open, onOpenChange, onBooked }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onBooked: (text: string) => void;
}) {
  const { api } = useAuth();
  const catalog = useCatalog(open);
  const [service, setService] = useState<Service | null>(null);
  const [branchId, setBranchId] = useState<number | 0>(0);
  const [doctorId, setDoctorId] = useState<number | 0>(0);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [date, setDate] = useState("");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>("");

  useEffect(() => {
    if (!open) {
      setService(null);
      setBranchId(0);
      setDoctorId(0);
      setSlots(null);
      setDate("");
      setSlot(null);
      setDone("");
    }
  }, [open]);

  // Специалиста нет в расписании (например, ортопеда) — ведём на консультацию терапевта
  const specialty = service ? (service.available ? service.specialty : "терапевт") : "";
  const doctors = useMemo(
    () => (catalog?.doctors ?? []).filter((d) => d.specialty === specialty && (!branchId || d.branch_id === branchId)),
    [catalog, specialty, branchId],
  );
  const branches = useMemo(() => {
    const ids = new Set((catalog?.doctors ?? []).filter((d) => d.specialty === specialty).map((d) => d.branch_id));
    return (catalog?.branches ?? []).filter((b) => ids.has(b.id));
  }, [catalog, specialty]);

  useEffect(() => {
    if (!specialty) return;
    setSlots(null);
    setDate("");
    setSlot(null);
    const q = new URLSearchParams({ specialty });
    if (branchId) q.set("branch_id", String(branchId));
    if (doctorId) q.set("doctor_id", String(doctorId));
    api<{ slots: Slot[] }>(`slots?${q}`)
      .then((r) => setSlots(r.slots))
      .catch(() => setSlots([]));
  }, [specialty, branchId, doctorId, api]);

  const days = useMemo(() => [...new Set((slots ?? []).map((s) => s.start_at.slice(0, 10)))].slice(0, 7), [slots]);
  const daySlots = (slots ?? []).filter((s) => s.start_at.startsWith(date));

  const book = async () => {
    if (!slot || !service) return;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message: string }>("book", { body: { slot_id: slot.id } });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const text = `${service.name}: ${slot.when}, ${slot.doctor}, ${slot.branch}`;
      setDone(text);
      onBooked(text);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Не получилось записаться");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      open={open}
      onOpenChange={onOpenChange}
      title="Запись на приём"
      subtitle="Выберите услугу, врача и удобное время"
      footer={
        done ? (
          <PrimaryButton
            className="w-full"
            onClick={() => onOpenChange(false)}
          >
            Вернуться в чат
          </PrimaryButton>
        ) : (
          <div className="flex items-center gap-3">
            <div className="text-muted-foreground min-w-0 flex-1 text-[12.5px] leading-snug">
              {slot ? (
                <>
                  <b className="text-foreground">{slot.when}</b>
                  <br />
                  {slot.doctor}
                </>
              ) : (
                "Выберите время, чтобы записаться"
              )}
            </div>
            <PrimaryButton
              disabled={!slot || busy}
              onClick={book}
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <CalendarCheck className="size-4" />}
              Записаться
            </PrimaryButton>
          </div>
        )
      }
    >
      {done ? (
        <div className="msg-in flex flex-col items-center gap-3 py-8 text-center">
          <span className="bg-ok-tint text-ok grid size-14 place-items-center rounded-2xl">
            <Check className="size-7" />
          </span>
          <div className="text-[18px] font-semibold">Вы записаны</div>
          <div className="text-muted-foreground max-w-xs text-[14px]">{done}</div>
          <Notice>Администратор в чате подскажет, как подготовиться, и может прислать напоминание.</Notice>
        </div>
      ) : !catalog ? (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-[14px]">
          <LoaderCircle className="size-4 animate-spin" /> Загружаю услуги…
        </div>
      ) : (
        <>
          <Section
            n={1}
            title="Услуга"
            done={!!service}
          >
            <div className="grid grid-cols-1 gap-2">
              {catalog.services.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => {
                    setService(s);
                    setBranchId(0);
                    setDoctorId(0);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-colors",
                    service?.name === s.name ? "border-ink bg-secondary" : "border-border hover:bg-secondary",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium">{s.name}</span>
                    <span className="text-muted-foreground block text-[12.5px]">{s.hint}</span>
                  </span>
                  <span className="text-[13px] font-medium whitespace-nowrap">{s.price}</span>
                </button>
              ))}
            </div>
            {service && !service.available && (
              <div className="mt-2">
                <Notice tone="warn">Такого специалиста сейчас нет в расписании. Запишем на консультацию терапевта: он составит план.</Notice>
              </div>
            )}
          </Section>

          {service && (
            <Section
              n={2}
              title="Филиал и врач"
              done={!!doctorId}
            >
              <div className="mb-3 flex flex-wrap gap-2">
                <Chip
                  active={!branchId}
                  onClick={() => {
                    setBranchId(0);
                    setDoctorId(0);
                  }}
                >
                  Любой филиал
                </Chip>
                {branches.map((b) => (
                  <Chip
                    key={b.id}
                    active={branchId === b.id}
                    onClick={() => {
                      setBranchId(b.id);
                      setDoctorId(0);
                    }}
                  >
                    <MapPin className="size-3.5" />
                    {b.name.replace("Филиал ", "")}
                  </Chip>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                {doctors.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDoctorId(doctorId === d.id ? 0 : d.id)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-colors",
                      doctorId === d.id ? "border-ink bg-secondary" : "border-border hover:bg-secondary",
                    )}
                  >
                    <span className="bg-tile grid size-10 flex-none place-items-center rounded-xl text-[13px] font-semibold">
                      {d.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                    </span>
                    <span className="min-w-0 flex-1 text-[12.5px]">
                      <span className="block text-[14px] font-medium">{d.name}</span>
                      {d.specialty}, {d.branch} · <RatingLine d={d} />
                    </span>
                    {doctorId === d.id && <Check className="size-4" />}
                  </button>
                ))}
                {!doctors.length && <Notice>В этом филиале нет такого врача. Выберите другой филиал.</Notice>}
                <p className="text-muted-foreground text-[12px]">Врача можно не выбирать: покажем время всех подходящих.</p>
              </div>
            </Section>
          )}

          {service && (
            <Section
              n={3}
              title="День и время"
              done={!!slot}
            >
              {slots === null ? (
                <div className="text-muted-foreground flex items-center gap-2 text-[13.5px]">
                  <LoaderCircle className="size-4 animate-spin" /> Смотрю расписание…
                </div>
              ) : !slots.length ? (
                <Notice tone="warn">Свободного времени нет. Попробуйте другой филиал или врача.</Notice>
              ) : (
                <>
                  <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
                    {days.map((d) => (
                      <Chip
                        key={d}
                        active={date === d}
                        onClick={() => {
                          setDate(d);
                          setSlot(null);
                        }}
                        className="flex-none"
                      >
                        {dayLabel(d)}
                      </Chip>
                    ))}
                  </div>
                  {date && (
                    <div className="grid grid-cols-3 gap-2">
                      {daySlots.map((s) => (
                        <Chip
                          key={s.id}
                          active={slot?.id === s.id}
                          onClick={() => setSlot(s)}
                          className="flex-col items-start justify-center gap-0 rounded-2xl"
                          title={`${s.doctor}, ${s.branch}`}
                        >
                          <b className="text-[15px] tabular-nums">{s.start_at.slice(11)}</b>
                          {!doctorId && <span className="truncate text-[11px] opacity-70">{s.doctor.split(" ").slice(-1)[0]}</span>}
                        </Chip>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Section>
          )}
        </>
      )}
    </Panel>
  );
}

/* ---------- Мои записи и диалоги ---------- */

export function VisitsPanel({ open, onOpenChange, onOpen, onNewThread, onSelectThread, currentThread }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onOpen: (p: PanelName, opts?: { doctorId?: number }) => void;
  onNewThread: () => void;
  onSelectThread: (id: string) => void;
  currentThread: string | null;
}) {
  const { api } = useAuth();
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [threads, setThreads] = useState<{ thread_id: string; title: string; at: string }[]>([]);
  const [confirm, setConfirm] = useState<number | null>(null);

  const load = () => {
    api<{ appointments: Appointment[] }>("me").then((r) => setAppts(r.appointments)).catch(() => setAppts([]));
    api<{ threads: typeof threads }>("threads").then((r) => setThreads(r.threads)).catch(() => {});
  };
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cancel = async (id: number) => {
    try {
      const r = await api<{ ok: boolean; message: string }>("cancel", { body: { appointment_id: id } });
      (r.ok ? toast.success : toast.error)(r.message);
      setConfirm(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Не получилось отменить");
    }
  };

  const upcoming = (appts ?? []).filter((a) => a.status === "active");
  const past = (appts ?? []).filter((a) => a.status !== "active");

  return (
    <Panel
      open={open}
      onOpenChange={onOpenChange}
      title="Личный кабинет"
      subtitle="Ваши записи и диалоги с администратором"
    >
      <Label>Предстоящие приёмы</Label>
      {appts === null ? (
        <div className="text-muted-foreground mb-5 text-[13.5px]">Загружаю…</div>
      ) : !upcoming.length ? (
        <div className="mb-5 flex flex-col gap-2">
          <Notice>Записей пока нет.</Notice>
          <PrimaryButton onClick={() => onOpen("book")}>
            <CalendarCheck className="size-4" />
            Записаться на приём
          </PrimaryButton>
        </div>
      ) : (
        <div className="mb-5 flex flex-col gap-2">
          {upcoming.map((a) => (
            <div
              key={a.id}
              className="border-border rounded-2xl border p-3.5"
            >
              <div className="text-[15px] font-semibold">{a.when}</div>
              <div className="text-muted-foreground text-[13px]">
                {a.doctor}, {a.specialty} · {a.branch}
              </div>
              <div className="mt-2.5 flex gap-2">
                {confirm === a.id ? (
                  <>
                    <Chip
                      className="border-bad/40 text-bad"
                      onClick={() => cancel(a.id)}
                    >
                      <CalendarX className="size-3.5" /> Да, отменить
                    </Chip>
                    <Chip onClick={() => setConfirm(null)}>Не отменять</Chip>
                  </>
                ) : (
                  <Chip onClick={() => setConfirm(a.id)}>
                    <CalendarX className="size-3.5" /> Отменить
                  </Chip>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!!past.length && (
        <>
          <Label>Прошедшие и отменённые</Label>
          <div className="mb-5 flex flex-col gap-2">
            {past.map((a) => (
              <div
                key={a.id}
                className="border-border flex items-center gap-3 rounded-2xl border p-3"
              >
                <div className="min-w-0 flex-1 text-[13px]">
                  <span className={cn("font-medium", a.status === "cancelled" && "line-through opacity-60")}>{a.when}</span>
                  <div className="text-muted-foreground truncate">{a.doctor}</div>
                </div>
                {a.status === "past" ? (
                  <Chip onClick={() => onOpen("review", { doctorId: a.doctor_id })}>
                    <Star className="size-3.5" /> Отзыв
                  </Chip>
                ) : (
                  <span className="text-muted-foreground text-[12px]">отменена</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mb-2 flex items-center">
        <Label>Мои диалоги</Label>
        <button
          type="button"
          onClick={onNewThread}
          className="text-muted-foreground hover:text-foreground mb-2 ml-auto inline-flex cursor-pointer items-center gap-1 text-[12.5px]"
        >
          <SquarePen className="size-3.5" /> Новый
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {threads.map((t) => (
          <button
            key={t.thread_id}
            type="button"
            onClick={() => onSelectThread(t.thread_id)}
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors",
              t.thread_id === currentThread ? "border-ink bg-secondary" : "border-border hover:bg-secondary",
            )}
          >
            <MessageSquare className="text-muted-foreground size-4 flex-none" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px]">{t.title}</span>
              <span className="text-muted-foreground text-[11.5px]">{t.at.slice(8, 10)}.{t.at.slice(5, 7)} {t.at.slice(11, 16)}</span>
            </span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

/* ---------- Отзыв ---------- */

export function ReviewPanel({ open, onOpenChange, doctorId, onSent }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  doctorId?: number;
  onSent: (text: string) => void;
}) {
  const { api } = useAuth();
  const catalog = useCatalog(open);
  const [doc, setDoc] = useState<number>(0);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (open) {
      setDoc(doctorId ?? 0);
      setRating(0);
      setText("");
      setResult(null);
    }
  }, [open, doctorId]);

  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message: string }>("review", { body: { doctor_id: doc, rating, text } });
      setResult(r);
      if (r.ok) {
        const d = catalog?.doctors.find((x) => x.id === doc);
        onSent(`оценка ${rating} из 5, врач ${d?.name ?? ""}`);
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : "Не получилось отправить" });
    } finally {
      setBusy(false);
    }
  };

  const hints = ["", "Очень плохо", "Плохо", "Нормально", "Хорошо", "Отлично"];

  return (
    <Panel
      open={open}
      onOpenChange={onOpenChange}
      title="Отзыв о враче"
      subtitle="Отзыв увидят другие пациенты"
      footer={
        result?.ok ? (
          <PrimaryButton
            className="w-full"
            onClick={() => onOpenChange(false)}
          >
            Готово
          </PrimaryButton>
        ) : (
          <PrimaryButton
            className="w-full"
            disabled={!doc || !rating || text.trim().length < 5 || busy}
            onClick={send}
          >
            {busy && <LoaderCircle className="size-4 animate-spin" />}
            Отправить отзыв
          </PrimaryButton>
        )
      }
    >
      {result?.ok ? (
        <div className="msg-in flex flex-col items-center gap-3 py-8 text-center">
          <span className="bg-ok-tint text-ok grid size-14 place-items-center rounded-2xl">
            <Check className="size-7" />
          </span>
          <div className="text-[17px] font-semibold">Спасибо!</div>
          <div className="text-muted-foreground max-w-xs text-[14px]">{result.message}</div>
        </div>
      ) : (
        <>
          <Label>Врач</Label>
          <div className="mb-5 flex flex-col gap-2">
            {(catalog?.doctors ?? []).map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setDoc(d.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-colors",
                  doc === d.id ? "border-ink bg-secondary" : "border-border hover:bg-secondary",
                )}
              >
                <span className="min-w-0 flex-1 text-[12.5px]">
                  <span className="block text-[14px] font-medium">{d.name}</span>
                  {d.specialty} · <RatingLine d={d} />
                </span>
                {doc === d.id && <Check className="size-4" />}
              </button>
            ))}
          </div>
          <Label>Оценка</Label>
          <div className="mb-5 flex items-center gap-3">
            <Stars
              value={rating}
              onChange={setRating}
            />
            <span className="text-muted-foreground text-[13px]">{hints[rating]}</span>
          </div>
          <Label>Пара слов о приёме</Label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 600))}
            rows={4}
            placeholder="Что понравилось, что можно улучшить"
            className="border-input focus:border-ink/50 w-full resize-none rounded-2xl border bg-transparent px-3.5 py-2.5 text-[14.5px] outline-none"
          />
          <div className="text-muted-foreground mt-1 text-right text-[11.5px]">{text.length} / 600</div>
          {result && !result.ok && <Notice tone="bad">{result.message}</Notice>}
        </>
      )}
    </Panel>
  );
}

/* ---------- Свои MCP-серверы ---------- */

type McpInfo = {
  enabled: boolean;
  presets: { name: string; url: string; about: string }[];
  servers: { url: string; status: string; at: string; error: string | null; tools: { name: string; description: string }[] }[];
  limits: { servers: number; tools: number };
};

export function McpPanel({ open, onOpenChange, threadId, onAsk }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  threadId: string | null;
  onAsk: (text: string) => void;
}) {
  const { api } = useAuth();
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const load = () =>
    api<McpInfo>(`mcp?thread_id=${encodeURIComponent(threadId ?? "")}`)
      .then(setInfo)
      .catch(() => {});
  useEffect(() => {
    if (open) {
      setMsg(null);
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, threadId]);

  const connect = async (u: string) => {
    setBusy(u);
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; message: string }>("mcp/connect", { body: { thread_id: threadId, url: u } });
      setMsg(r);
      if (r.ok) setUrl("");
      load();
    } catch (e) {
      setMsg({ ok: false, message: e instanceof ApiError ? e.message : "Не получилось подключить" });
    } finally {
      setBusy("");
    }
  };

  const connected = (info?.servers ?? []).filter((s) => s.status === "ok");
  const full = connected.length >= (info?.limits.servers ?? 3);

  return (
    <Panel
      open={open}
      onOpenChange={onOpenChange}
      title="Свои MCP-серверы"
      subtitle="Подключите внешние инструменты к этому диалогу"
    >
      {info && !info.enabled ? (
        <Notice tone="warn">Клиника выключила подключение внешних серверов. Включить можно в админ-панели, вкладка «Внешние MCP».</Notice>
      ) : (
        <>
          <Label>Адрес сервера</Label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) connect(url.trim());
            }}
            className="mb-2 flex gap-2"
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://адрес/mcp"
              inputMode="url"
              className="border-input focus:border-ink/50 h-11 min-w-0 flex-1 rounded-full border bg-transparent px-4 text-[14px] outline-none"
            />
            <PrimaryButton
              type="submit"
              disabled={!url.trim() || !!busy || full}
            >
              {busy === url.trim() && busy ? <LoaderCircle className="size-4 animate-spin" /> : <Plug className="size-4" />}
              Подключить
            </PrimaryButton>
          </form>
          <p className="text-muted-foreground mb-4 text-[12px] leading-snug">
            Подходит сервер с транспортом Streamable HTTP (адрес обычно кончается на /mcp) или SSE (/sse), без логина и пароля.
            Свой сервер можно запустить на другом ПК в этой же сети и указать его адрес вида http://192.168.x.x:9000/mcp.
          </p>
          {msg && (
            <div className="mb-4">
              <Notice tone={msg.ok ? "ok" : "bad"}>{msg.message}</Notice>
            </div>
          )}

          {!!connected.length && (
            <>
              <Label>Подключено в этом диалоге</Label>
              <div className="mb-5 flex flex-col gap-2">
                {connected.map((s) => (
                  <div
                    key={s.url + s.at}
                    className="border-border rounded-2xl border p-3"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="bg-ok size-1.5 rounded-full" />
                      <code className="truncate text-[12.5px]">{s.url}</code>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {s.tools.map((t) => (
                        <div
                          key={t.name}
                          className="bg-secondary rounded-xl px-2.5 py-1.5 text-[12.5px]"
                        >
                          <span className="font-medium">{t.name}</span>{" "}
                          <span className="text-warn text-[11px] font-semibold">недоверенный</span>
                          <div className="text-muted-foreground line-clamp-2">{t.description}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <GhostButton
                  onClick={() => {
                    onAsk("Какие внешние инструменты подключены в этом чате и что они умеют?");
                    onOpenChange(false);
                  }}
                >
                  Спросить агента про эти инструменты
                </GhostButton>
              </div>
            </>
          )}

          <Label>Проверенные публичные серверы</Label>
          <div className="mb-5 flex flex-col gap-2">
            {(info?.presets ?? []).map((p) => {
              const on = connected.some((s) => s.url === p.url);
              return (
                <div
                  key={p.url}
                  className="border-border flex items-center gap-3 rounded-2xl border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">{p.name}</div>
                    <div className="text-muted-foreground text-[12.5px]">{p.about}</div>
                    <code className="text-muted-foreground block truncate text-[11.5px]">{p.url}</code>
                  </div>
                  <Chip
                    active={on}
                    disabled={on || !!busy || full}
                    onClick={() => connect(p.url)}
                  >
                    {busy === p.url ? <LoaderCircle className="size-3.5 animate-spin" /> : on ? <Check className="size-3.5" /> : <Plug className="size-3.5" />}
                    {on ? "Есть" : "Подключить"}
                  </Chip>
                </div>
              );
            })}
          </div>

          <div className="bg-secondary rounded-2xl p-3.5 text-[12.5px] leading-relaxed">
            <div className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold">
              <ShieldCheck className="size-4" /> Как клиника защищается от чужих серверов
            </div>
            Инструменты видны только в этом диалоге и получают приставку ext_. Адреса этого компьютера запрещены.
            Описания и ответы сервера помечаются как недоверенные и обрезаются. Если агент попытается отправить наружу
            ваши данные, код или данные других людей, отправка отменяется. Не больше {info?.limits.servers ?? 3} серверов
            и {info?.limits.tools ?? 10} инструментов на сервер.
          </div>
        </>
      )}
    </Panel>
  );
}
