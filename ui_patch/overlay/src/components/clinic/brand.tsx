"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

/** Знак клиники: зуб в плитке «чернилами». */
export function ToothMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      className={className}
    >
      <path
        fill="currentColor"
        d="M22.6 14c-5.9 0-9.6 4.8-9.6 10.8 0 4 1.5 7 2.9 10.4 1.6 3.9 2 8.4 3 12.6.7 2.9 1.8 5.2 3.9 5.2 2.4 0 3.1-2.6 3.8-6.2.8-4 1.6-8.3 5.4-8.3s4.6 4.3 5.4 8.3c.7 3.6 1.4 6.2 3.8 6.2 2.1 0 3.2-2.3 3.9-5.2 1-4.2 1.4-8.7 3-12.6 1.4-3.4 2.9-6.4 2.9-10.4 0-6-3.7-10.8-9.6-10.8-4 0-6.2 2-9.4 2s-5.4-2-9.4-2z"
      />
    </svg>
  );
}

export function BrandTile({
  size = 36,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "bg-ink text-on-ink grid flex-none place-items-center",
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
      }}
    >
      <ToothMark className="h-[62%] w-[62%]" />
    </span>
  );
}

export function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("clinic-theme", next ? "dark" : "light");
    } catch {
      // приватный режим браузера: тема просто не запомнится
    }
  };
  return { dark, toggle };
}

export function ThemeToggle() {
  const { dark, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "Светлая тема" : "Тёмная тема"}
      aria-label={dark ? "Включить светлую тему" : "Включить тёмную тему"}
      className="text-muted-foreground hover:text-foreground hover:bg-accent grid size-9 cursor-pointer place-items-center rounded-full transition-colors"
    >
      {dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </button>
  );
}
