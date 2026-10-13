"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

/* Вход по телефону и коду. Токен хранится в браузере, сервер знает только его хеш.
   Все запросы кабинета идут через /gw (прокси к gateway/server.py). */

export type Role = "patient" | "doctor" | "admin";
/** Тот, кто вошёл: пациент или сотрудник. Роль ставит шлюз при входе по коду. */
export type Patient = { name: string; first_name: string; polite: string; phone: string; role?: Role; role_ru?: string };
export type AuthStatus = "loading" | "guest" | "need_name" | "ready";

type AuthContextType = {
  status: AuthStatus;
  token: string;
  patient: Patient | null;
  role: Role;
  api: <T = any>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  /** После кода: сохраняет токен и пациента. thread_id — первый чат, его создал шлюз. */
  signedIn: (data: { token: string; need_name?: boolean; patient?: Patient }) => void;
  registered: (patient: Patient) => void;
  logout: () => Promise<void>;
};

// Ключ сменили в версии 18: вход старых версий (без выбора роли) больше не подхватывается,
// и после обновления все снова видят окно входа с выбором роли
const KEY = "clinic-token-v18";
const AuthContext = createContext<AuthContextType | undefined>(undefined);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`/gw/${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { "x-clinic-token": token } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let data: any = {};
  try {
    data = await r.json();
  } catch {
    // пустой ответ
  }
  if (!r.ok) throw new ApiError(r.status, data?.detail || "Не получилось, попробуйте ещё раз");
  return data as T;
}

function readToken() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

function saveToken(t: string) {
  try {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch {
    // приватный режим: вход проживёт до закрытия вкладки
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState("");
  const [patient, setPatient] = useState<Patient | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    const t = readToken();
    if (!t) {
      setStatus("guest");
      return;
    }
    call<{ patient?: Patient; need_name?: boolean }>(t, "me")
      .then((d) => {
        setToken(t);
        if (d.need_name) setStatus("need_name");
        else {
          setPatient(d.patient ?? null);
          setStatus("ready");
        }
      })
      .catch(() => {
        saveToken("");
        setStatus("guest");
      });
  }, []);

  const api = useCallback(
    <T,>(path: string, init?: { method?: string; body?: unknown }) => call<T>(token, path, init),
    [token],
  );

  const value = useMemo<AuthContextType>(
    () => ({
      status,
      token,
      patient,
      role: patient?.role ?? "patient",
      api,
      signedIn: (d) => {
        saveToken(d.token);
        setToken(d.token);
        if (d.need_name || !d.patient) setStatus("need_name");
        else {
          setPatient(d.patient);
          setStatus("ready");
        }
      },
      registered: (p) => {
        setPatient(p);
        setStatus("ready");
      },
      logout: async () => {
        try {
          await call(token, "auth/logout", { body: {} });
        } catch {
          // всё равно выходим
        }
        saveToken("");
        setToken("");
        setPatient(null);
        setStatus("guest");
      },
    }),
    [status, token, patient, api],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth вне AuthProvider");
  return ctx;
}

/* Действия чата для кнопок в сообщениях и панелях: отправить текст, открыть панель. */
export type PanelName = "book" | "visits" | "review" | "mcp" | "dialogs" | null;
export type ChatActions = {
  send: (text: string) => void;
  openPanel: (p: PanelName, opts?: { doctorId?: number }) => void;
  threadId: string | null;
  isLoading: boolean;
};
export const ChatActionsContext = createContext<ChatActions | undefined>(undefined);
export function useChatActions() {
  return useContext(ChatActionsContext);
}
