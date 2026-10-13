import { AIMessage, ToolMessage } from "@langchain/langgraph-sdk";
import { useState } from "react";
import { Check, ChevronDown, LoaderCircle, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStreamContext } from "@/providers/Stream";
import { argLabel, isDenied, toolMeta } from "@/components/clinic/tool-meta";

function asText(content: ToolMessage["content"] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text?: string }).text ?? "") : ""))
    .join("\n");
}

function show(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/* Один шаг агента: что он делает словами, статус и раскрывашка с подробностями
   (инструмент, аргументы, ответ). Результат берётся из ToolMessage с тем же id. */
function ToolStep({ call }: { call: NonNullable<AIMessage["tool_calls"]>[number] }) {
  const [open, setOpen] = useState(false);
  const thread = useStreamContext();
  const args = (call.args ?? {}) as Record<string, unknown>;
  const meta = toolMeta(call.name, args);
  const result = thread.messages.find(
    (m): m is ToolMessage => m.type === "tool" && (m as ToolMessage).tool_call_id === call.id,
  );
  const text = asText(result?.content);
  const pending = !result;
  const denied = !pending && isDenied(text);
  const entries = Object.entries(args).filter(([, v]) => v !== "" && v != null);

  return (
    <div
      className={cn(
        "msg-in overflow-hidden rounded-2xl border transition-colors",
        denied ? "border-warn/40 bg-warn-tint" : "border-border bg-sheet",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left"
      >
        <span
          className={cn(
            "grid size-7 flex-none place-items-center rounded-[9px]",
            denied ? "text-warn bg-transparent" : "bg-tile",
          )}
        >
          {denied ? <ShieldAlert className="size-4" /> : <meta.icon className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px]">
          <span className={cn("font-medium", denied && "text-warn")}>{pending ? meta.label : meta.done}</span>
          {pending && <span className="text-muted-foreground">…</span>}
        </span>
        {pending ? (
          <LoaderCircle className="text-muted-foreground size-4 animate-spin" />
        ) : denied ? (
          <span className="text-warn text-[12px] font-semibold">отказ</span>
        ) : (
          <Check className="text-ok size-4" />
        )}
        <ChevronDown
          className={cn("text-muted-foreground size-4 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="border-border space-y-2 border-t px-3 py-2.5 text-[12.5px]">
          <div className="text-muted-foreground">
            инструмент <code className="bg-secondary text-foreground rounded-md px-1.5 py-0.5 font-mono text-[12px]">{call.name}</code>
          </div>
          {entries.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {entries.map(([k, v]) => (
                <div
                  key={k}
                  className="contents"
                >
                  <dt className="text-muted-foreground">{argLabel(k)}</dt>
                  <dd className="break-all">{show(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {!pending && (
            <div className="bg-secondary rounded-xl px-3 py-2 whitespace-pre-wrap">{text || "пустой ответ"}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCalls({ toolCalls }: { toolCalls: AIMessage["tool_calls"] }) {
  if (!toolCalls || toolCalls.length === 0) return null;
  return (
    <div className="flex w-full max-w-xl flex-col gap-1.5">
      {toolCalls.map((tc, idx) => (
        <ToolStep
          key={tc.id ?? idx}
          call={tc}
        />
      ))}
    </div>
  );
}

/* Результаты показываются внутри шага (ToolStep), отдельной карточкой не рисуются. */
export function ToolResult(_props: { message: ToolMessage }) {
  return null;
}
