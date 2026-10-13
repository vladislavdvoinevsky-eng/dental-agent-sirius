import { useStreamContext } from "@/providers/Stream";
import { Message } from "@langchain/langgraph-sdk";
import { getContentString } from "../utils";
import { cn } from "@/lib/utils";
import { BranchSwitcher, CommandBar } from "./shared";

/* Сообщение пациента: таблетка «чернилами» справа. Правка отправленного сообщения
   убрана: она создаёт ветки диалога и путает тех, кто видит чат впервые. */
export function HumanMessage({
  message,
  isLoading,
}: {
  message: Message;
  isLoading: boolean;
}) {
  const thread = useStreamContext();
  const meta = thread.getMessagesMetadata(message);
  const contentString = getContentString(message.content);
  if (!contentString) return null;

  return (
    <div className="group msg-in ml-auto flex max-w-[85%] flex-col items-end gap-1">
      <p className="bg-ink text-on-ink w-fit rounded-[20px] rounded-tr-md px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
        {contentString}
      </p>
      <div
        className={cn(
          "flex items-center gap-1 transition-opacity",
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
          isLoading={isLoading}
          content={contentString}
          isHumanMessage={true}
        />
      </div>
    </div>
  );
}
