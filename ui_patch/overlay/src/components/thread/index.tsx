import { v4 as uuidv4 } from "uuid";
import { ReactNode, useCallback, useEffect, useRef, useState, FormEvent } from "react";
import { cn } from "@/lib/utils";
import { useStreamContext } from "@/providers/Stream";
import { Checkpoint, Message } from "@langchain/langgraph-sdk";
import { AssistantMessage, AssistantMessageLoading } from "./messages/ai";
import { HumanMessage } from "./messages/human";
import { DO_NOT_RENDER_ID_PREFIX, ensureToolCallsHaveResponses } from "@/lib/ensure-tool-responses";
import { ArrowDown, ArrowUp, CalendarCheck, IdCard, LogOut, PanelLeft, Plug, SquarePen, Square, Star } from "lucide-react";
import { useQueryState, parseAsBoolean } from "nuqs";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { toast } from "sonner";
import { Switch } from "../ui/switch";
import { useArtifactOpen, useArtifactContext } from "./artifact";
import { BrandTile, ThemeToggle } from "@/components/clinic/brand";
import { Welcome } from "@/components/clinic/welcome";
import { ChatActionsContext, PanelName, useAuth } from "@/components/clinic/auth";
import { LoginDialog } from "@/components/clinic/login";
import { BookPanel, McpPanel, ReviewPanel, VisitsPanel } from "@/components/clinic/panels";
import { ChatSidebar } from "@/components/clinic/sidebar";

// Столько же пропускает защитный прокси (ui_patch/route.ts): длиннее он обрежет.
const MAX_CHARS = 2000;

function StickyToBottomContent(props: {
  content: ReactNode;
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const context = useStickToBottomContext();
  return (
    <div
      ref={context.scrollRef}
      style={{ width: "100%", height: "100%" }}
      className={props.className}
    >
      <div
        ref={context.contentRef}
        className={props.contentClassName}
      >
        {props.content}
      </div>
      {props.footer}
    </div>
  );
}

function ScrollToBottom(props: { className?: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      className={cn(
        "bg-sheet border-border text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] shadow-sm",
        props.className,
      )}
      onClick={() => scrollToBottom()}
    >
      <ArrowDown className="size-3.5" />К последним сообщениям
    </button>
  );
}

/* Жив ли агент: тот же /info, по которому чат проверяет связь при загрузке. */
function useOnline(apiUrl: string) {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch(`${apiUrl}/info`)
        .then((r) => alive && setOnline(r.ok))
        .catch(() => alive && setOnline(false));
    check();
    const t = setInterval(check, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [apiUrl]);
  return online;
}

/* Одна видеокарта на всю группу: если ответ задерживается, объясняем почему. */
function useSlowHint(isLoading: boolean) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 25_000);
    return () => clearTimeout(t);
  }, [isLoading]);
  return slow;
}

function friendlyError(message: string): string {
  if (/429|Слишком много/i.test(message)) return "Слишком много сообщений подряд. Подождите минуту и напишите снова.";
  if (/413|Слишком большой/i.test(message)) return "Сообщение слишком длинное, сократите его.";
  if (/401|Войдите/i.test(message)) return "Этот диалог недоступен. Открываю новый.";
  if (/fetch|network|Failed/i.test(message)) return "Нет связи с администратором. Проверьте интернет и попробуйте ещё раз.";
  return "Не получилось отправить сообщение. Попробуйте ещё раз.";
}

function initials(name?: string) {
  return (name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/* Меню пациента в шапке: кабинет, запись, отзыв, MCP, выход. */
function UserMenu({ onPanel }: { onPanel: (p: PanelName) => void }) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (auth.status !== "ready" || !auth.patient) return null;
  const patientItems: { icon: typeof IdCard; label: string; act: () => void }[] = [
    { icon: IdCard, label: "Мои записи", act: () => onPanel("visits") },
    { icon: CalendarCheck, label: "Записаться на приём", act: () => onPanel("book") },
    { icon: Star, label: "Оставить отзыв", act: () => onPanel("review") },
    { icon: Plug, label: "Подключить MCP-сервер", act: () => onPanel("mcp") },
  ];
  const items = [
    ...(auth.role === "patient" ? patientItems : []),
    { icon: LogOut, label: auth.role === "patient" ? "Выйти" : "Выйти (сменить роль)", act: () => auth.logout() },
  ];
  return (
    <div
      ref={ref}
      className="relative"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="hover:bg-secondary flex h-9 cursor-pointer items-center gap-2 rounded-full pr-1 pl-1 transition-colors sm:pr-3"
      >
        <span className="bg-ink text-on-ink grid size-7 place-items-center rounded-full text-[11.5px] font-semibold">
          {initials(auth.patient.polite)}
        </span>
        <span className="hidden max-w-36 min-w-0 text-left sm:block">
          <span className="block truncate text-[13px] leading-tight font-medium">{auth.patient.polite}</span>
          {auth.role !== "patient" && (
            <span className="text-muted-foreground block text-[11px] leading-tight">{auth.patient.role_ru}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="sheet msg-in absolute top-11 right-0 z-30 w-64 rounded-2xl p-1.5">
          <div className="border-border mb-1 border-b px-3 pt-1.5 pb-2.5">
            <div className="truncate text-[13.5px] font-semibold">{auth.patient.name}</div>
            <div className="text-muted-foreground text-[12px] tabular-nums">
              {auth.patient.role_ru ?? "Пациент"} · {auth.patient.phone}
            </div>
          </div>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              onClick={() => {
                setOpen(false);
                it.act();
              }}
              className="hover:bg-secondary flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px]"
            >
              <it.icon className="text-muted-foreground size-4" />
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Thread() {
  const [, setArtifactContext] = useArtifactContext();
  const [, closeArtifact] = useArtifactOpen();
  const auth = useAuth();

  const [threadId, _setThreadId] = useQueryState("threadId");
  const [hideToolCalls, setHideToolCalls] = useQueryState("hideToolCalls", parseAsBoolean.withDefault(false));
  const [input, setInput] = useState("");
  const [panel, setPanel] = useState<PanelName>(null);
  const [reviewDoctor, setReviewDoctor] = useState<number | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const stream = useStreamContext();
  const messages = stream.messages;
  const isLoading = stream.isLoading;
  const online = useOnline(stream.apiUrl);
  const slow = useSlowHint(isLoading);
  const ready = auth.status === "ready";
  const isPatient = auth.role === "patient";

  const lastError = useRef<string | undefined>(undefined);

  const setThreadId = useCallback(
    (id: string | null) => {
      _setThreadId(id);
      closeArtifact();
      setArtifactContext({});
    },
    [_setThreadId, closeArtifact, setArtifactContext],
  );

  // Новый диалог создаёт шлюз и сразу привязывает к пациенту
  const newThread = useCallback(async () => {
    try {
      const r = await auth.api<{ thread_id: string }>("threads", { body: {} });
      setThreadId(r.thread_id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не получилось начать диалог");
    }
  }, [auth, setThreadId]);

  // После входа: продолжаем последний диалог или начинаем новый
  useEffect(() => {
    if (!ready || threadId) return;
    auth
      .api<{ threads: { thread_id: string }[] }>("threads")
      .then((r) => (r.threads[0] ? setThreadId(r.threads[0].thread_id) : newThread()))
      .catch(() => newThread());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, threadId]);

  // Вышли — убираем диалог из адреса
  useEffect(() => {
    if (auth.status === "guest" && threadId) setThreadId(null);
  }, [auth.status, threadId, setThreadId]);

  useEffect(() => {
    if (!stream.error) {
      lastError.current = undefined;
      return;
    }
    const message = String((stream.error as { message?: string })?.message ?? stream.error);
    if (!message || lastError.current === message) return;
    lastError.current = message;
    toast.error(friendlyError(message), { closeButton: true });
    // Чужой или устаревший диалог в адресе: открываем свой новый
    if (/401|Войдите/i.test(message) && ready) newThread();
  }, [stream.error, ready, newThread]);

  const send = (text: string) => {
    const clean = text.trim().slice(0, MAX_CHARS);
    if (!clean || isLoading || !ready || !threadId) return;

    const newHumanMessage: Message = {
      id: uuidv4(),
      type: "human",
      content: [{ type: "text", text: clean }] as Message["content"],
    };
    const toolMessages = ensureToolCallsHaveResponses(stream.messages);

    stream.submit(
      { messages: [...toolMessages, newHumanMessage] },
      {
        streamMode: ["values"],
        streamSubgraphs: true,
        streamResumable: true,
        optimisticValues: (prev) => ({
          ...prev,
          messages: [...(prev.messages ?? []), ...toolMessages, newHumanMessage],
        }),
      },
    );
    setInput("");
    textareaRef.current?.focus();
  };

  const openPanel = (p: PanelName, opts?: { doctorId?: number }) => {
    setReviewDoctor(opts?.doctorId);
    setPanel(p);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  const handleRegenerate = (parentCheckpoint: Checkpoint | null | undefined) => {
    stream.submit(undefined, {
      checkpoint: parentCheckpoint,
      streamMode: ["values"],
      streamSubgraphs: true,
      streamResumable: true,
    });
  };

  const chatStarted = messages.length > 0;
  const hasNoAIOrToolMessages = !messages.find((m) => m.type === "ai" || m.type === "tool");
  // «Печатает» — пока модель думает: после вопроса и после каждого выполненного шага.
  // Пока шаг выполняется, крутится его собственный значок.
  const lastType = messages[messages.length - 1]?.type;
  const showTyping = isLoading && (lastType === undefined || lastType === "human" || lastType === "tool");

  const quick: { icon: typeof IdCard; label: string; panel: PanelName }[] = [
    { icon: CalendarCheck, label: "Записаться", panel: "book" },
    { icon: IdCard, label: "Мои записи", panel: "visits" },
    { icon: Star, label: "Отзыв", panel: "review" },
    { icon: Plug, label: "MCP", panel: "mcp" },
  ];

  return (
    <ChatActionsContext.Provider value={{ send, openPanel, threadId, isLoading }}>
      <div className="flex h-dvh w-full justify-center sm:p-[14px]">
        <div className="sheet relative flex w-full max-w-[1240px] min-w-0 overflow-hidden sm:rounded-[22px]">
          <ChatSidebar
            current={threadId}
            onSelect={(id) => {
              setSidebarOpen(false);
              if (id !== threadId) setThreadId(id);
            }}
            onNew={() => {
              setSidebarOpen(false);
              newThread();
            }}
            refreshKey={`${threadId}|${isLoading}`}
            mobileOpen={sidebarOpen}
            onMobileClose={() => setSidebarOpen(false)}
          />
          <div className="relative flex min-w-0 flex-1 flex-col">
          {/* Шапка */}
          <header className="border-border flex items-center gap-3 border-b px-4 py-3 sm:px-5">
            {ready && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                title="Диалоги"
                aria-label="Открыть список диалогов"
                className="hover:bg-secondary -ml-1 grid size-9 flex-none cursor-pointer place-items-center rounded-full md:hidden"
              >
                <PanelLeft className="size-[18px]" />
              </button>
            )}
            <div className="flex min-w-0 items-center gap-3">
              <BrandTile size={36} />
              <span className="min-w-0">
                <span className="block truncate text-[15px] leading-tight font-semibold">Стоматология</span>
                <span className="text-muted-foreground flex items-center gap-1.5 text-[12.5px] leading-tight">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      online === null ? "bg-muted-foreground/50" : online ? "bg-ok" : "bg-bad",
                    )}
                  />
                  {online === false
                    ? "помощник не на связи"
                    : auth.role === "doctor"
                      ? "помощник врача"
                      : auth.role === "admin"
                        ? "помощник регистратуры"
                        : "онлайн-администратор"}
                </span>
              </span>
            </div>

            <div className="ml-auto flex items-center gap-1 sm:gap-2">
              <label
                className="text-muted-foreground hidden cursor-pointer items-center gap-2 rounded-full px-2 py-1 text-[12.5px] select-none md:flex"
                title="Показывать, какие действия выполняет агент"
              >
                <Switch
                  checked={!hideToolCalls}
                  onCheckedChange={(v) => setHideToolCalls(!v)}
                />
                Шаги агента
              </label>
              <ThemeToggle />
              {ready && chatStarted && (
                <button
                  type="button"
                  onClick={newThread}
                  title="Новый диалог"
                  className="border-input hover:bg-secondary flex h-9 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-medium transition-colors sm:px-3.5 md:hidden"
                >
                  <SquarePen className="size-4" />
                  <span className="hidden lg:inline">Новый диалог</span>
                </button>
              )}
              <UserMenu onPanel={openPanel} />
            </div>
          </header>

          <StickToBottom className="relative flex-1 overflow-hidden">
            <StickyToBottomContent
              className="scrollbar-soft absolute inset-0 grid grid-cols-[minmax(0,1fr)] grid-rows-[1fr_auto] overflow-x-hidden overflow-y-auto px-4"
              contentClassName="pt-6 pb-6 max-w-3xl mx-auto flex flex-col gap-4 w-full"
              content={
                <>
                  {!chatStarted && (
                    <Welcome
                      name={auth.patient?.polite}
                      role={auth.role}
                      onPick={send}
                      onPanel={openPanel}
                      disabled={isLoading || !ready}
                    />
                  )}
                  {messages
                    .filter((m) => !m.id?.startsWith(DO_NOT_RENDER_ID_PREFIX))
                    .map((message, index) =>
                      message.type === "human" ? (
                        <HumanMessage
                          key={message.id || `${message.type}-${index}`}
                          message={message}
                          isLoading={isLoading}
                        />
                      ) : (
                        <AssistantMessage
                          key={message.id || `${message.type}-${index}`}
                          message={message}
                          isLoading={isLoading}
                          handleRegenerate={handleRegenerate}
                        />
                      ),
                    )}
                  {hasNoAIOrToolMessages && !!stream.interrupt && (
                    <AssistantMessage
                      key="interrupt-msg"
                      message={undefined}
                      isLoading={isLoading}
                      handleRegenerate={handleRegenerate}
                    />
                  )}
                  {showTyping && <AssistantMessageLoading />}
                  {slow && (
                    <p className="text-muted-foreground msg-in pl-10 text-[12.5px]">
                      Сейчас с администратором общается много людей, ответ может занять до минуты.
                    </p>
                  )}
                </>
              }
              footer={
                <div className="bg-sheet sticky bottom-0 flex flex-col items-center pb-4">
                  <div className="from-sheet pointer-events-none absolute inset-x-0 bottom-full h-6 bg-gradient-to-t to-transparent" />
                  <ScrollToBottom className="animate-in fade-in-0 zoom-in-95 absolute bottom-full left-1/2 mb-3 -translate-x-1/2" />

                  {ready && chatStarted && isPatient && (
                    <div className="mx-auto mb-2 flex w-full max-w-3xl gap-1.5 overflow-x-auto [scrollbar-width:none]">
                      {quick.map((q) => (
                        <button
                          key={q.label}
                          type="button"
                          onClick={() => openPanel(q.panel)}
                          className="border-border text-muted-foreground hover:text-foreground hover:bg-secondary inline-flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors"
                        >
                          <q.icon className="size-3.5" />
                          {q.label}
                        </button>
                      ))}
                    </div>
                  )}

                  <form
                    onSubmit={handleSubmit}
                    className="border-input bg-sheet focus-within:border-ink/40 focus-within:shadow-[0_0_0_4px_var(--track)] relative mx-auto flex w-full max-w-3xl items-end gap-2 rounded-[24px] border p-1.5 pl-4 transition-[border-color,box-shadow]"
                  >
                    <textarea
                      ref={textareaRef}
                      value={input}
                      maxLength={MAX_CHARS}
                      rows={1}
                      disabled={!ready}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          e.currentTarget.closest("form")?.requestSubmit();
                        }
                      }}
                      placeholder={
                        !ready
                          ? "Войдите, чтобы написать"
                          : chatStarted
                            ? "Напишите сообщение…"
                            : auth.role === "doctor"
                              ? "Например: кто у меня сегодня?"
                              : auth.role === "admin"
                                ? "Например: запишите Соколова к терапевту на завтра"
                                : "Например: запишите меня к терапевту"
                      }
                      aria-label="Сообщение"
                      className="field-sizing-content placeholder:text-muted-foreground max-h-48 min-h-10 flex-1 resize-none border-none bg-transparent py-2 text-[15px] leading-6 shadow-none outline-none"
                    />
                    {isLoading ? (
                      <button
                        key="stop"
                        type="button"
                        onClick={() => stream.stop()}
                        title="Остановить"
                        aria-label="Остановить ответ"
                        className="bg-secondary hover:bg-accent grid size-10 flex-none cursor-pointer place-items-center rounded-full transition-colors"
                      >
                        <Square className="size-3.5 fill-current" />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        title="Отправить"
                        aria-label="Отправить"
                        disabled={!input.trim() || !ready}
                        className="bg-ink text-on-ink grid size-10 flex-none cursor-pointer place-items-center rounded-full transition-[transform,opacity] hover:scale-105 active:scale-95 disabled:cursor-default disabled:opacity-25 disabled:hover:scale-100"
                      >
                        <ArrowUp className="size-[18px]" />
                      </button>
                    )}
                  </form>
                  <p className="text-muted-foreground mt-2 px-2 text-center text-[11.5px]">
                    {input.length > MAX_CHARS * 0.8
                      ? `${input.length} из ${MAX_CHARS} символов`
                      : "Enter — отправить, Shift+Enter — новая строка. Не пишите в чат пароли и данные карт."}
                  </p>
                </div>
              }
            />
          </StickToBottom>
          </div>
        </div>
      </div>

      <LoginDialog onThread={(id) => setThreadId(id)} />
      {ready && isPatient && (
        <>
          <BookPanel
            open={panel === "book"}
            onOpenChange={(v) => setPanel(v ? "book" : null)}
            onBooked={(text) => send(`Я записался через форму: ${text}. Как подготовиться к приёму?`)}
          />
          <VisitsPanel
            open={panel === "visits"}
            onOpenChange={(v) => setPanel(v ? "visits" : null)}
            onOpen={openPanel}
            currentThread={threadId}
            onNewThread={() => {
              setPanel(null);
              newThread();
            }}
            onSelectThread={(id) => {
              setPanel(null);
              setThreadId(id);
            }}
          />
          <ReviewPanel
            open={panel === "review"}
            onOpenChange={(v) => setPanel(v ? "review" : null)}
            doctorId={reviewDoctor}
            onSent={() => {}}
          />
          <McpPanel
            open={panel === "mcp"}
            onOpenChange={(v) => setPanel(v ? "mcp" : null)}
            threadId={threadId}
            onAsk={send}
          />
        </>
      )}
    </ChatActionsContext.Provider>
  );
}
