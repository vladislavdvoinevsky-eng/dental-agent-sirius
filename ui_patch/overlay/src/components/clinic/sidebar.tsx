"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, MessageSquare, SquarePen, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "./auth";

/* Список диалогов слева. Каждый диалог хранится в базе (chat_log) и принадлежит тому, кто вошёл:
   после перезапуска агента шлюз поднимает переписку из базы, поэтому старые диалоги открываются с историей. */

export type ThreadItem = { thread_id: string; title: string; at: string; messages?: number };

function when(at: string) {
  const d = at.slice(0, 10);
  const today = new Date();
  const iso = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d === iso(today)) return at.slice(11, 16);
  if (d === iso(yesterday)) return "вчера";
  return `${at.slice(8, 10)}.${at.slice(5, 7)}`;
}

function List({
  threads,
  current,
  onSelect,
}: {
  threads: ThreadItem[] | null;
  current: string | null;
  onSelect: (id: string) => void;
}) {
  if (threads === null)
    return (
      <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-[13px]">
        <LoaderCircle className="size-3.5 animate-spin" /> Загружаю…
      </div>
    );
  if (!threads.length) return <div className="text-muted-foreground px-3 py-2 text-[13px]">Диалогов пока нет</div>;
  return (
    <div className="flex flex-col gap-0.5">
      {threads.map((t) => {
        const active = t.thread_id === current;
        const empty = !t.messages && t.title === "Новый диалог";
        return (
          <button
            key={t.thread_id}
            type="button"
            onClick={() => onSelect(t.thread_id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors",
              active ? "bg-secondary" : "hover:bg-secondary/70",
            )}
          >
            <MessageSquare
              className={cn("size-4 flex-none", active ? "text-foreground" : "text-muted-foreground")}
            />
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate text-[13.5px]", active && "font-medium", empty && "text-muted-foreground")}>
                {t.title}
              </span>
            </span>
            <span className="text-muted-foreground flex-none text-[11.5px] tabular-nums">{when(t.at)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ChatSidebar({
  current,
  onSelect,
  onNew,
  refreshKey,
  mobileOpen,
  onMobileClose,
}: {
  current: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  refreshKey: string;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const { api, status } = useAuth();
  const [threads, setThreads] = useState<ThreadItem[] | null>(null);

  useEffect(() => {
    if (status !== "ready") return;
    let alive = true;
    api<{ threads: ThreadItem[] }>("threads")
      .then((r) => alive && setThreads(r.threads))
      .catch(() => alive && setThreads((t) => t ?? []));
    return () => {
      alive = false;
    };
  }, [api, status, refreshKey]);

  if (status !== "ready") return null;

  const body = (
    <>
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="text-muted-foreground text-[12px] font-semibold tracking-wide uppercase">Диалоги</span>
        <button
          type="button"
          onClick={onNew}
          className="border-input hover:bg-secondary ml-auto inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors"
        >
          <SquarePen className="size-3.5" /> Новый
        </button>
      </div>
      <nav className="scrollbar-soft min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <List
          threads={threads}
          current={current}
          onSelect={onSelect}
        />
      </nav>
    </>
  );

  return (
    <>
      {/* Компьютер: колонка слева всегда видна */}
      <aside className="border-border hidden w-[260px] flex-none flex-col border-r md:flex">{body}</aside>

      {/* Телефон: выезжающая панель по кнопке в шапке */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-label="Диалоги"
        >
          <button
            type="button"
            aria-label="Закрыть список диалогов"
            onClick={onMobileClose}
            className="absolute inset-0 cursor-default bg-black/30"
          />
          <aside className="bg-sheet msg-in absolute inset-y-0 left-0 flex w-[82%] max-w-[320px] flex-col shadow-xl">
            {body}
            <button
              type="button"
              onClick={onMobileClose}
              className="border-border text-muted-foreground hover:text-foreground flex h-11 flex-none cursor-pointer items-center justify-center gap-1.5 border-t text-[13px]"
            >
              <X className="size-4" /> Закрыть
            </button>
          </aside>
        </div>
      )}
    </>
  );
}
