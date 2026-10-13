import {
  BookOpen,
  CalendarCheck,
  CalendarClock,
  CalendarSearch,
  CalendarX,
  ClipboardList,
  IdCard,
  MessageSquareHeart,
  Plug,
  Puzzle,
  Send,
  ShieldCheck,
  Star,
  UserPlus,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/* Человеческие названия шагов агента. Имя инструмента остаётся в раскрывашке:
   на защите проекта удобно показать, какой именно инструмент вызвала модель. */
type Meta = { icon: LucideIcon; label: string; done: string };

const TOOLS: Record<string, Meta> = {
  search_clinic_info: { icon: BookOpen, label: "Смотрю в базе знаний клиники", done: "Нашёл в базе знаний" },
  get_free_slots: { icon: CalendarSearch, label: "Ищу свободное время", done: "Проверил расписание" },
  verify_patient: { icon: ShieldCheck, label: "Проверяю личность", done: "Проверка личности" },
  register_patient: { icon: UserPlus, label: "Регистрирую нового пациента", done: "Регистрация пациента" },
  get_patient_info: { icon: IdCard, label: "Открываю карточку пациента", done: "Открыл карточку" },
  book_appointment: { icon: CalendarCheck, label: "Записываю на приём", done: "Запись на приём" },
  cancel_appointment: { icon: CalendarX, label: "Отменяю запись", done: "Отмена записи" },
  reschedule_appointment: { icon: CalendarClock, label: "Переношу запись", done: "Перенос записи" },
  send_message: { icon: Send, label: "Отправляю сообщение", done: "Отправка сообщения" },
  get_doctor_reviews: { icon: Star, label: "Смотрю отзывы о врачах", done: "Отзывы о врачах" },
  leave_review: { icon: MessageSquareHeart, label: "Сохраняю отзыв", done: "Отзыв принят" },
  connect_mcp_server: { icon: Plug, label: "Подключаю внешний сервер", done: "Внешний сервер" },
  get_treatment_plan: { icon: ClipboardList, label: "Открываю план лечения", done: "План лечения" },
  get_my_schedule: { icon: CalendarSearch, label: "Смотрю расписание врача", done: "Расписание врача" },
  get_patient_card: { icon: IdCard, label: "Открываю карточку пациента", done: "Карточка пациента" },
  add_treatment_plan: { icon: ClipboardList, label: "Добавляю план лечения", done: "План лечения" },
  message_patient: { icon: Send, label: "Пишу пациенту", done: "Сообщение пациенту" },
  find_patient: { icon: IdCard, label: "Ищу пациента", done: "Поиск пациента" },
  get_schedule: { icon: CalendarSearch, label: "Смотрю записи врачей", done: "Записи врачей" },
  book_for_patient: { icon: CalendarCheck, label: "Записываю пациента", done: "Запись пациента" },
  cancel_any_appointment: { icon: CalendarX, label: "Отменяю запись", done: "Отмена записи" },
  remind_patient: { icon: Send, label: "Отправляю напоминание", done: "Напоминание" },
};

export function toolMeta(name: string, args?: Record<string, unknown>): Meta {
  if (name === "verify_patient") {
    return args && args.code
      ? { icon: ShieldCheck, label: "Проверяю код подтверждения", done: "Проверка кода" }
      : { icon: ShieldCheck, label: "Отправляю код подтверждения", done: "Запрос кода" };
  }
  if (TOOLS[name]) return TOOLS[name];
  if (name.startsWith("ext_")) {
    return { icon: Puzzle, label: `Внешний инструмент ${name.slice(4)}`, done: `Внешний инструмент ${name.slice(4)}` };
  }
  return { icon: Wrench, label: name, done: name };
}

/* Те же признаки отказа, что подсвечивает админка: без подтверждения, неверный код,
   чужая запись, лимиты. */
const DENIED = [
  "Сначала нужно подтвердить",
  "Неверный код",
  "Попытки закончились",
  "не найдена",
  "недоступен",
  "Слишком много",
  "уже выполнена",
  "Код не отправлен",
  "Отправка отменена",
  "адрес запрещён",
  "выключен",
  "не создана",
  "НЕ создана",
  "уже занято",
  "нет предстоящих",
  "Записи с номером",
  "уже есть запись",
  "Врач видит только своих",
];

export function isDenied(result: string): boolean {
  return DENIED.some((d) => result.includes(d));
}

/* Аргументы по-русски, чтобы раскрывашка читалась без знания кода. */
const ARG_LABELS: Record<string, string> = {
  query: "запрос",
  specialty: "специальность",
  branch: "филиал",
  date: "дата",
  phone: "телефон",
  birth_date: "дата рождения",
  code: "код",
  full_name: "ФИО",
  slot_id: "окно №",
  appointment_id: "запись №",
  channel: "канал",
  template: "шаблон",
  doctor: "врач",
  time: "время",
  patient_id: "пациент №",
  diagnosis: "диагноз",
  plan: "план",
  cost: "стоимость",
  rating: "оценка",
  text: "текст",
  url: "адрес",
};

export function argLabel(key: string): string {
  return ARG_LABELS[key] ?? key;
}
