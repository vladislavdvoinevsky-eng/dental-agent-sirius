import { parsePartialJson } from "@langchain/core/output_parsers";
import { useStreamContext } from "@/providers/Stream";
import { AIMessage, Checkpoint, Message } from "@langchain/langgraph-sdk";
import { useStream } from "@langchain/langgraph-sdk/react";
import { getContentString } from "../utils";
import { BranchSwitcher, CommandBar } from "./shared";
import { MarkdownText } from "../markdown-text";
import { LoadExternalComponent } from "@langchain/langgraph-sdk/react-ui";
import { cn } from "@/lib/utils";
import { ToolCalls } from "./tool-calls";
import { MessageContentComplex } from "@langchain/core/messages";
import { Fragment } from "react/jsx-runtime";
import { isAgentInboxInterruptSchema } from "@/lib/agent-inbox-interrupt";
import { ThreadView } from "../agent-inbox";
import { useQueryState, parseAsBoolean } from "nuqs";
import { GenericInterruptView } from "./generic-interrupt";
import { useArtifact } from "../artifact";
import { BrandTile } from "@/components/clinic/brand";
import { QuickReplies, splitOptions } from "@/components/clinic/replies";

function CustomComponent({
  message,
  thread,
}: {
  message: Message;
  thread: ReturnType<typeof useStreamContext>;
}) {
  const artifact = useArtifact();
  const { values } = useStreamContext();
  const customComponents = values.ui?.filter(
    (ui) => ui.metadata?.message_id === message.id,
  );

  if (!customComponents?.length) return null;
  return (
    <Fragment key={message.id}>
      {customComponents.map((customComponent) => (
        <LoadExternalComponent
          key={customComponent.id}
          stream={thread as unknown as ReturnType<typeof useStream>}
          message={customComponent}
          meta={{ ui: customComponent, artifact }}
        />
      ))}
    </Fragment>
  );
}

function parseAnthropicStreamedToolCalls(
  content: MessageContentComplex[],
): AIMessage["tool_calls"] {
  const toolCallContents = content.filter((c) => c.type === "tool_use" && c.id);

  return toolCallContents.map((tc) => {
    const toolCall = tc as Record<string, any>;
    let json: Record<string, any> = {};
    if (toolCall?.input) {
      try {
        json = parsePartialJson(toolCall.input) ?? {};
      } catch {
        // Pass
      }
    }
    return {
      name: toolCall.name ?? "",
      id: toolCall.id ?? "",
      args: json,
      type: "tool_call",
    };
  });
}

interface InterruptProps {
  interrupt?: unknown;
  isLastMessage: boolean;
  hasNoAIOrToolMessages: boolean;
}

function Interrupt({
  interrupt,
  isLastMessage,
  hasNoAIOrToolMessages,
}: InterruptProps) {
  const fallbackValue = Array.isArray(interrupt)
    ? (interrupt as Record<string, any>[])
    : (((interrupt as { value?: unknown } | undefined)?.value ??
        interrupt) as Record<string, any>);

  return (
    <>
      {isAgentInboxInterruptSchema(interrupt) &&
        (isLastMessage || hasNoAIOrToolMessages) && (
          <ThreadView interrupt={interrupt} />
        )}
      {interrupt &&
      !isAgentInboxInterruptSchema(interrupt) &&
      (isLastMessage || hasNoAIOrToolMessages) ? (
        <GenericInterruptView interrupt={fallbackValue} />
      ) : null}
    </>
  );
}

export function AssistantMessage({
  message,
  isLoading,
  handleRegenerate,
}: {
  message: Message | undefined;
  isLoading: boolean;
  handleRegenerate: (parentCheckpoint: Checkpoint | null | undefined) => void;
}) {
  const content = message?.content ?? [];
  // Строку «Варианты: …» показываем кнопками под сообщением, а не текстом
  const { body: contentString, options } = splitOptions(getContentString(content));
  const [hideToolCalls] = useQueryState(
    "hideToolCalls",
    parseAsBoolean.withDefault(false),
  );

  const thread = useStreamContext();
  const isLastMessage =
    thread.messages[thread.messages.length - 1]?.id === message?.id;
  const hasNoAIOrToolMessages = !thread.messages.find(
    (m) => m.type === "ai" || m.type === "tool",
  );
  const meta = message ? thread.getMessagesMetadata(message) : undefined;
  const threadInterrupt = thread.interrupt;

  const parentCheckpoint = meta?.firstSeenState?.parent_checkpoint;
  const anthropicStreamedToolCalls = Array.isArray(content)
    ? parseAnthropicStreamedToolCalls(content)
    : undefined;

  const toolCalls =
    message && "tool_calls" in message && message.tool_calls?.length
      ? message.tool_calls
      : anthropicStreamedToolCalls;

  // Результат инструмента рисуется внутри шага агента, отдельно его не показываем.
  if (message?.type === "tool") {
    return (
      <Interrupt
        interrupt={threadInterrupt}
        isLastMessage={isLastMessage}
        hasNoAIOrToolMessages={hasNoAIOrToolMessages}
      />
    );
  }

  const showSteps = !hideToolCalls && !!toolCalls?.length;
  if (!contentString && !showSteps && !threadInterrupt) return null;

  return (
    <div className="group msg-in mr-auto flex w-full items-start gap-2.5">
      {contentString ? (
        <BrandTile
          size={30}
          className="mt-0.5"
        />
      ) : (
        <span className="w-[30px] flex-none" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {showSteps && <ToolCalls toolCalls={toolCalls} />}

        {contentString.length > 0 && (
          <div className="bg-secondary w-fit max-w-full rounded-[20px] rounded-tl-md px-4 py-2.5 text-[15px] leading-relaxed">
            <MarkdownText>{contentString}</MarkdownText>
          </div>
        )}

        {isLastMessage && !isLoading && contentString.length > 0 && (
          <QuickReplies
            options={options}
            messages={thread.messages}
          />
        )}

        {message && (
          <CustomComponent
            message={message}
            thread={thread}
          />
        )}
        <Interrupt
          interrupt={threadInterrupt}
          isLastMessage={isLastMessage}
          hasNoAIOrToolMessages={hasNoAIOrToolMessages}
        />
        {contentString.length > 0 && (
          <div
            className={cn(
              "mr-auto -mt-1 flex items-center gap-1 transition-opacity",
              "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
            )}
          >
            <BranchSwitcher
              branch={meta?.branch}
              branchOptions={meta?.branchOptions}
              onSelect={(branch) => thread.setBranch(branch)}
              isLoading={isLoading}
            />
            <CommandBar
              content={contentString}
              isLoading={isLoading}
              isAiMessage={true}
              handleRegenerate={() => handleRegenerate(parentCheckpoint)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function AssistantMessageLoading() {
  return (
    <div className="msg-in mr-auto flex items-center gap-2.5">
      <BrandTile size={30} />
      <div className="bg-secondary text-muted-foreground flex h-10 items-center gap-2.5 rounded-[20px] rounded-tl-md px-4 text-[13.5px]">
        <span className="flex gap-1">
          <span className="typing-dot bg-foreground/60 size-1.5 rounded-full" />
          <span className="typing-dot bg-foreground/60 size-1.5 rounded-full [animation-delay:.15s]" />
          <span className="typing-dot bg-foreground/60 size-1.5 rounded-full [animation-delay:.3s]" />
        </span>
        Администратор печатает
      </div>
    </div>
  );
}
