// Защищённый прокси между браузером и LangGraph-сервером.
// Разрешает только то, что нужно чату, и вырезает из запросов поля,
// через которые можно было бы подменить чужую сессию или состояние.
export const runtime = "nodejs";

const UPSTREAM = (process.env.LANGGRAPH_API_URL || "http://127.0.0.1:2024").replace(/\/$/, "");
const ID = "[0-9a-fA-F-]{8,64}";

// Чаты создаёт только шлюз кабинета после входа по телефону (gateway/server.py), браузер — нет.
const RULES: { method: string; re: RegExp }[] = [
  { method: "GET", re: /^info$/ },
  { method: "GET", re: new RegExp(`^threads/${ID}$`) },
  { method: "GET", re: new RegExp(`^threads/${ID}/history$`) },
  { method: "POST", re: new RegExp(`^threads/${ID}/history$`) },
  { method: "POST", re: new RegExp(`^threads/${ID}/runs/stream$`) },
  { method: "GET", re: new RegExp(`^threads/${ID}/runs/${ID}/stream$`) },
  { method: "POST", re: new RegExp(`^threads/${ID}/runs/${ID}/cancel$`) },
  { method: "POST", re: /^assistants\/search$/ },
  { method: "GET", re: /^assistants\/[^/]+(\/(graph|schemas))?$/ },
];

const MAX_INPUT_CHARS = 2000;
const PER_IP_PER_MIN = 8;      // сообщений в минуту с одного адреса
const GLOBAL_PER_MIN = 40;     // сообщений в минуту всего (видеокарта одна)
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (k: string) => (hits.get(k) || []).filter((t) => now - t < 60_000);
  const mine = recent(ip), all = recent("*");
  if (mine.length >= PER_IP_PER_MIN || all.length >= GLOBAL_PER_MIN) return true;
  hits.set(ip, [...mine, now]); hits.set("*", [...all, now]);
  return false;
}

function clientIp(req: Request): string {
  // через туннель Cloudflare настоящий адрес собеседника приходит в cf-connecting-ip
  return req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || req.headers.get("x-real-ip") || "unknown";
}

// Из входа пропускаем только обычные текстовые сообщения пользователя
function cleanInput(input: unknown): { messages: { type: string; content: string }[] } | null {
  if (!input || typeof input !== "object") return null;
  const msgs = (input as { messages?: unknown }).messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const out: { type: string; content: string }[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") return null;
    const type = String((m as { type?: string; role?: string }).type ?? (m as { role?: string }).role ?? "");
    if (type !== "human" && type !== "user") return null;
    const c = (m as { content?: unknown }).content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : "")).join(" ");
    else return null;
    text = text.trim();
    if (!text) return null;
    out.push({ type: "human", content: text.slice(0, MAX_INPUT_CHARS) });
  }
  return { messages: out.slice(-1) };
}

// Доступ к чату только его хозяину: токен входа из заголовка x-clinic-token проверяет шлюз.
// Ответ кешируется на минуту, чтобы не спрашивать шлюз на каждый кусок потока.
const GATEWAY = (process.env.CLINIC_GATEWAY_URL || "http://127.0.0.1:8090").replace(/\/$/, "");
const INTERNAL_KEY = process.env.CLINIC_INTERNAL_KEY || "";
const allowed = new Map<string, number>();

async function ownsThread(token: string, threadId: string): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const key = `${token}|${threadId}`;
  const until = allowed.get(key);
  if (until && until > Date.now()) return true;
  try {
    const r = await fetch(`${GATEWAY}/internal/check?thread_id=${encodeURIComponent(threadId)}`, {
      headers: { "x-clinic-token": token, "x-internal-key": INTERNAL_KEY },
    });
    if (r.ok) {
      if (allowed.size > 5000) allowed.clear();
      allowed.set(key, Date.now() + 60_000);
      return true;
    }
  } catch {
    // шлюз не запущен: в чат не пускаем
  }
  return false;
}

function deny(status: number, detail: string) {
  return Response.json({ detail }, { status, headers: SECURITY_HEADERS });
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

// Поля запуска, которые пропускаем. config/context/command и прочее вырезаем.
const RUN_FIELDS = ["input", "assistant_id", "stream_mode", "stream_subgraphs", "stream_resumable",
  "on_disconnect", "multitask_strategy", "if_not_exists", "checkpoint", "checkpoint_id"];

async function handle(req: Request, ctx: { params: Promise<{ _path?: string[] }> }) {
  const parts = (await ctx.params)._path || [];
  const path = parts.join("/");
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204 });

  // Список чужих диалогов не отдаём никому
  if (method === "POST" && path === "threads/search") {
    return Response.json([], { headers: SECURITY_HEADERS });
  }
  if (!RULES.some((r) => r.method === method && r.re.test(path))) {
    return deny(403, "Запрещено");
  }
  const thread = path.match(/^threads\/([^/]+)/);
  if (thread && !(await ownsThread(req.headers.get("x-clinic-token") || "", thread[1]))) {
    return deny(401, "Войдите в чат по номеру телефона");
  }

  let body: string | undefined;
  if (method !== "GET") {
    const text = await req.text();
    let json: Record<string, unknown> = {};
    if (text.length > 20_000) return deny(413, "Слишком большой запрос");
    try { json = text ? JSON.parse(text) : {}; } catch { return deny(400, "Bad JSON"); }
    if (path.endsWith("/runs/stream")) {
      if (rateLimited(clientIp(req))) return deny(429, "Слишком много сообщений, подождите минуту");
      const clean: Record<string, unknown> = {};
      for (const k of RUN_FIELDS) if (k in json) clean[k] = json[k];
      if (clean.input == null) delete clean.input;
      if ("input" in clean) {
        const input = cleanInput(clean.input);
        if (!input) return deny(400, "Разрешены только текстовые сообщения пользователя");
        clean.input = input;
      }
      clean.assistant_id = "agent";
      json = clean;
    }
    body = JSON.stringify(json);
  }

  const url = new URL(req.url);
  const upstream = await fetch(`${UPSTREAM}/${path}${url.search}`, {
    method,
    headers: { "content-type": "application/json", accept: req.headers.get("accept") || "*/*" },
    body,
  });
  const headers = new Headers(SECURITY_HEADERS);
  for (const h of ["content-type", "content-location", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
