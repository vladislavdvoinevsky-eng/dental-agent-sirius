import { RefreshCcw, Copy, CopyCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { TooltipIconButton } from "../tooltip-icon-button";
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Button } from "@/components/ui/button";

function ContentCopyable({ content, disabled }: { content: string; disabled: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <TooltipIconButton
      onClick={(e) => handleCopy(e)}
      variant="ghost"
      tooltip={copied ? "Скопировано" : "Скопировать"}
      disabled={disabled}
      className="text-muted-foreground hover:text-foreground size-7 rounded-full p-1.5"
    >
      <AnimatePresence
        mode="wait"
        initial={false}
      >
        {copied ? (
          <motion.div
            key="check"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
          >
            <CopyCheck className="text-ok size-4" />
          </motion.div>
        ) : (
          <motion.div
            key="copy"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
          >
            <Copy className="size-4" />
          </motion.div>
        )}
      </AnimatePresence>
    </TooltipIconButton>
  );
}

export function BranchSwitcher({
  branch,
  branchOptions,
  onSelect,
  isLoading,
}: {
  branch: string | undefined;
  branchOptions: string[] | undefined;
  onSelect: (branch: string) => void;
  isLoading: boolean;
}) {
  if (!branchOptions || !branch || branchOptions.length < 2) return null;
  const index = branchOptions.indexOf(branch);

  return (
    <div className="text-muted-foreground flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-6 rounded-full p-1"
        onClick={() => {
          const prevBranch = branchOptions[index - 1];
          if (prevBranch) onSelect(prevBranch);
        }}
        disabled={isLoading}
        aria-label="Предыдущий вариант"
      >
        <ChevronLeft />
      </Button>
      <span className="text-xs tabular-nums">
        {index + 1} / {branchOptions.length}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 rounded-full p-1"
        onClick={() => {
          const nextBranch = branchOptions[index + 1];
          if (nextBranch) onSelect(nextBranch);
        }}
        disabled={isLoading}
        aria-label="Следующий вариант"
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

export function CommandBar({
  content,
  isAiMessage,
  handleRegenerate,
  isLoading,
}: {
  content: string;
  isHumanMessage?: boolean;
  isAiMessage?: boolean;
  handleRegenerate?: () => void;
  isLoading: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <ContentCopyable
        content={content}
        disabled={isLoading}
      />
      {isAiMessage && !!handleRegenerate && (
        <TooltipIconButton
          disabled={isLoading}
          tooltip="Ответить иначе"
          variant="ghost"
          onClick={handleRegenerate}
          className="text-muted-foreground hover:text-foreground size-7 rounded-full p-1.5"
        >
          <RefreshCcw className="size-4" />
        </TooltipIconButton>
      )}
    </div>
  );
}
