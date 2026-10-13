"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ButtonHTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/* Общие элементы кабинета в стиле системы: плашки-варианты, таблетки, окно и боковая панель. */

export function Chip({
  active,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-left text-[13.5px] leading-tight transition-all disabled:pointer-events-none disabled:opacity-40",
        active
          ? "bg-ink text-on-ink border-ink"
          : "border-input bg-sheet hover:bg-secondary hover:border-ink/30 active:scale-[.98]",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function PrimaryButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "bg-ink text-on-ink inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full px-5 text-[14.5px] font-medium transition-[transform,opacity] hover:scale-[1.02] active:scale-[.98] disabled:pointer-events-none disabled:opacity-35",
        className,
      )}
      {...props}
    />
  );
}

export function GhostButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "border-input hover:bg-secondary inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full border px-5 text-[14px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground mb-2 text-[12.5px] font-medium">{children}</div>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "warn" | "bad"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-3.5 py-2.5 text-[13.5px] leading-snug",
        tone === "info" && "bg-secondary border-border",
        tone === "ok" && "bg-ok-tint text-ok border-ok/25",
        tone === "warn" && "bg-warn-tint text-warn border-warn/25",
        tone === "bad" && "bg-bad-tint text-bad border-bad/25",
      )}
    >
      {children}
    </div>
  );
}

/** Окно по центру (вход). dismissible=false — закрыть нельзя, только пройти шаги. */
export function Modal({
  open,
  onOpenChange,
  title,
  children,
  dismissible = true,
}: {
  open: boolean;
  onOpenChange?: (v: boolean) => void;
  title: string;
  children: ReactNode;
  dismissible?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={dismissible ? onOpenChange : undefined}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-40 bg-black/30 backdrop-blur-[3px]" />
        <Dialog.Content
          onEscapeKeyDown={(e) => !dismissible && e.preventDefault()}
          onPointerDownOutside={(e) => !dismissible && e.preventDefault()}
          className="sheet data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 w-[calc(100%-24px)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-[24px] p-6 outline-none"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Боковая панель кабинета: справа на компьютере, снизу на телефоне. */
export function Panel({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content className="sheet data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-6 sm:data-[state=open]:slide-in-from-right-6 fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-[24px] outline-none sm:inset-y-[14px] sm:right-[14px] sm:left-auto sm:max-h-none sm:w-[440px] sm:rounded-[22px]">
          <div className="border-border flex items-start gap-3 border-b px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[17px] font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="text-muted-foreground text-[12.5px]">{subtitle || title}</Dialog.Description>
            </div>
            <Dialog.Close
              className="text-muted-foreground hover:bg-secondary hover:text-foreground grid size-8 cursor-pointer place-items-center rounded-full"
              aria-label="Закрыть"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="scrollbar-soft flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="border-border border-t px-5 py-3.5">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Stars({ value, onChange, size = 28 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  return (
    <div
      className="flex gap-1"
      role={onChange ? "radiogroup" : undefined}
      aria-label="Оценка"
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(i)}
          aria-label={`${i} из 5`}
          className={cn("cursor-pointer transition-transform disabled:cursor-default", onChange && "hover:scale-110")}
          style={{ fontSize: size, lineHeight: 1, color: i <= value ? "#e3a52a" : "var(--input)" }}
        >
          ★
        </button>
      ))}
    </div>
  );
}
