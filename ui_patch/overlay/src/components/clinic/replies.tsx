"use client";

import { useState } from "react";
import { CalendarCheck, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import type { Message, ToolMessage } from "@langchain/langgraph-sdk";
import { ApiError, useAuth, useChatActions } from "./auth";
import { Chip } from "./ui";

/* Варианты ответа под сообщением агента.
   1) Агент сам пишет в конце строку «Варианты: a | b | c» (так велит промпт) — показываем кнопками,
      а саму строку прячем. Нажатие отправляет вариант как сообщение пациента: обычный текст, как с клавиатуры.
   2) Если агент только что искал свободное время, показываем найденные окна: нажатие записывает
      через кабинет (те же проверки, что у инструмента book_appointment), агенту уходит короткое сообщение. */

const OPTIONS_RE = /^\s*[*_]*\s*варианты\s*[*_]*\s*:\s*(.+)$/im;

export function splitOptions(text: string): { body: string; options: string[] } {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const m = lines[i].match(OPTIONS_RE);
    if (m) {
      const options = m[1]
        .split("|")
        .map((o) => o.replace(/[*_`]/g, "").trim())
        .filter((o) => o.length > 0 && o.length <= 60)
        .slice(0, 4);
      return { body: [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trimEnd(), options };
    }
  }
  return { body: text, options: [] };
}

type FoundSlot = { id: number; when: string; doctor: string; branch: string };
const SLOT_RE = /slot_id=(\d+):\s*([^,]+),\s*(.+?)\s*\([^)]*\),\s*(.+)$/;

function slotsSinceLastQuestion(messages: Message[]): FoundSlot[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "human") {
      start = i;
      break;
    }
  }
  const out: FoundSlot[] = [];
  for (const m of messages.slice(start)) {
    if (m.type !== "tool" || (m as ToolMessage).name !== "get_free_slots") continue;
    const text = typeof m.content === "string" ? m.content : "";
    for (const line of text.split("\n")) {
      const s = line.match(SLOT_RE);
      if (s) out.push({ id: Number(s[1]), when: s[2].trim(), doctor: s[3].trim(), branch: s[4].trim() });
    }
  }
  return out.slice(0, 6);
}

export function QuickReplies({ options, messages }: { options: string[]; messages: Message[] }) {
  const actions = useChatActions();
  const { api } = useAuth();
  const [pick, setPick] = useState<FoundSlot | null>(null);
  const [busy, setBusy] = useState(false);
  const slots = slotsSinceLastQuestion(messages);
  if (!actions || (!options.length && !slots.length)) return null;

  const book = async (s: FoundSlot) => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message: string }>("book", { body: { slot_id: s.id } });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`Вы записаны: ${s.when}`);
      actions.send(`Я записался через кнопку: ${s.when}, ${s.doctor}, ${s.branch}. Как подготовиться к приёму?`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Не получилось записаться");
    } finally {
      setBusy(false);
      setPick(null);
    }
  };

  return (
    <div className="msg-in flex flex-col gap-2">
      {!!slots.length && (
        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground text-[12px]">Записаться в одно нажатие:</div>
          {pick ? (
            <div className="border-input bg-sheet flex flex-wrap items-center gap-2 rounded-2xl border p-2.5 text-[13.5px]">
              <span className="min-w-0 flex-1 px-1">
                Записать на <b>{pick.when}</b>, {pick.doctor}, {pick.branch}?
              </span>
              <Chip
                active
                disabled={busy}
                onClick={() => book(pick)}
              >
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <CalendarCheck className="size-3.5" />}
                Да, записать
              </Chip>
              <Chip
                disabled={busy}
                onClick={() => setPick(null)}
              >
                Нет
              </Chip>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <Chip
                  key={s.id}
                  disabled={actions.isLoading}
                  onClick={() => setPick(s)}
                  title={`${s.doctor}, ${s.branch}`}
                >
                  <CalendarCheck className="size-3.5" />
                  {s.when} · {s.doctor.split(" ").slice(-1)[0]}
                </Chip>
              ))}
            </div>
          )}
        </div>
      )}
      {!!options.length && (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <Chip
              key={o}
              disabled={actions.isLoading}
              onClick={() => actions.send(o)}
            >
              {o}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
