"use client";

import {
  CalendarCheck,
  CalendarDays,
  ClipboardList,
  MessageCircle,
  Search,
  Stethoscope,
  UserRound,
  CalendarSearch,
  Clock,
  HeartPulse,
  IdCard,
  Lock,
  MapPin,
  Plug,
  Sparkles,
  Star,
  type LucideIcon,
} from "lucide-react";
import type { PanelName, Role } from "./auth";
import { BrandTile } from "./brand";

/* Первый экран: что умеет администратор, начать можно одним нажатием.
   Часть карточек открывает формы кабинета (запись, отзыв), часть отправляет вопрос агенту. */
type Item = { icon: LucideIcon; title: string; hint: string; text?: string; panel?: PanelName };

const ITEMS: Item[] = [
  { icon: CalendarCheck, title: "Записаться на приём", hint: "Услуга, врач и время в пару нажатий", panel: "book" },
  { icon: HeartPulse, title: "Болит зуб", hint: "Подскажу, к кому идти", text: "У меня болит зуб, что делать?" },
  { icon: Sparkles, title: "Цены на услуги", hint: "Чистка, лечение, импланты", text: "Сколько стоят ваши основные услуги?" },
  { icon: CalendarSearch, title: "Ближайшее время", hint: "Свободные окна врачей", text: "Какое ближайшее свободное время у терапевта?" },
  { icon: IdCard, title: "Мои записи", hint: "Перенести или отменить", panel: "visits" },
  { icon: Star, title: "Оставить отзыв", hint: "Оцените врача после приёма", panel: "review" },
];

// Врач и администратор работают только через чат: формы кабинета для пациентов
const DOCTOR_ITEMS: Item[] = [
  { icon: CalendarDays, title: "Расписание на сегодня", hint: "Мои пациенты и свободные окна", text: "Покажи моё расписание на сегодня" },
  { icon: CalendarSearch, title: "Кто у меня завтра", hint: "Записи на завтра", text: "Кто записан ко мне на завтра?" },
  { icon: UserRound, title: "Карточка пациента", hint: "История визитов и план лечения", text: "Открой карточку моего ближайшего пациента" },
  { icon: MessageCircle, title: "Написать пациенту", hint: "Telegram, MAX или WhatsApp", text: "Хочу написать сообщение пациенту" },
];
const ADMIN_ITEMS: Item[] = [
  { icon: ClipboardList, title: "Записи на сегодня", hint: "Все врачи и филиалы", text: "Покажи все записи на сегодня" },
  { icon: Search, title: "Найти пациента", hint: "По ФИО или телефону", text: "Найди пациента" },
  { icon: CalendarSearch, title: "Свободные окна", hint: "Ближайшее время врачей", text: "Какие ближайшие свободные окна у терапевта?" },
  { icon: Stethoscope, title: "Записать пациента", hint: "Пациент звонит по телефону", text: "Нужно записать пациента на приём" },
];
const INTRO: Record<Role, string> = {
  patient: "Подберу врача и удобное время, расскажу о ценах, перенесу или отменю запись. Пишите как удобно или выберите, с чего начать.",
  doctor: "Покажу ваше расписание и карточки ваших пациентов, помогу добавить план лечения и написать пациенту.",
  admin: "Помогу с регистратурой: записи всех врачей, поиск пациента, запись и отмена, напоминания.",
};

const FACTS: { icon: LucideIcon; text: string }[] = [
  { icon: MapPin, text: "Три филиала: Центр, Адлер, Сириус" },
  { icon: Clock, text: "Ежедневно с 9:00 до 20:00" },
  { icon: Lock, text: "Ваши данные видите только вы" },
];

export function Welcome({
  name,
  role = "patient",
  onPick,
  onPanel,
  disabled,
}: {
  name?: string;
  role?: Role;
  onPick: (text: string) => void;
  onPanel: (p: PanelName) => void;
  disabled?: boolean;
}) {
  return (
    <div className="msg-in mx-auto flex w-full max-w-2xl flex-col items-center px-1 pt-[5vh] pb-6 text-center">
      <BrandTile size={56} />
      <h1 className="mt-5 text-[26px] leading-tight font-semibold sm:text-[30px]">
        {name ? `Здравствуйте, ${name}!` : "Здравствуйте! Я администратор клиники"}
      </h1>
      <p className="text-muted-foreground mt-2 max-w-lg text-[15px] leading-relaxed">
        {INTRO[role]}
      </p>

      <div className="mt-7 grid w-full grid-cols-1 gap-2.5 text-left sm:grid-cols-2">
        {(role === "doctor" ? DOCTOR_ITEMS : role === "admin" ? ADMIN_ITEMS : ITEMS).map((s) => (
          <button
            key={s.title}
            type="button"
            disabled={disabled}
            onClick={() => (s.panel ? onPanel(s.panel) : s.text && onPick(s.text))}
            className="group border-border bg-sheet hover:border-input hover:bg-secondary flex cursor-pointer items-center gap-3 rounded-2xl border p-3 text-left transition-all hover:-translate-y-px active:translate-y-0 disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="bg-tile group-hover:bg-ink group-hover:text-on-ink grid size-10 flex-none place-items-center rounded-xl transition-colors">
              <s.icon className="size-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] leading-snug font-semibold">{s.title}</span>
              <span className="text-muted-foreground block truncate text-[12.5px]">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>

      {role === "patient" && (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPanel("mcp")}
        className="text-muted-foreground hover:text-foreground mt-4 inline-flex cursor-pointer items-center gap-1.5 text-[12.5px]"
      >
        <Plug className="size-3.5" /> Подключить свой MCP-сервер к чату
      </button>
      )}

      <div className="text-muted-foreground mt-5 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[12.5px]">
        {(role === "patient" ? FACTS : FACTS.slice(0, 2)).map((f) => (
          <span
            key={f.text}
            className="inline-flex items-center gap-1.5"
          >
            <f.icon className="size-3.5" />
            {f.text}
          </span>
        ))}
      </div>
    </div>
  );
}
