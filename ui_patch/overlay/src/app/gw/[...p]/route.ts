// Прокси к шлюзу личного кабинета (gateway/server.py, только 127.0.0.1:8090).
// Наружу открыт строгий список путей; служебная проверка /internal/check сюда не входит.
export const runtime = "nodejs";

const GATEWAY = (process.env.CLINIC_GATEWAY_URL || "http://127.0.0.1:8090").replace(/\/$/, "");

const RULES: { method: string; path: string }[] = [
  { method: "GET", path: "health" },
  { method: "POST", path: "auth/request" },
  { method: "POST", path: "auth/verify" },
  { method: "POST", path: "auth/register" },
  { method: "POST", path: "auth/logout" },
  { method: "GET", path: "me" },
  { method: "GET", path: "threads" },
  { method: "POST", path: "threads" },
  { method: "GET", path: "catalog" },
  { method: "GET", path: "slots" },
  { method: "POST", path: "book" },
  { method: "POST", path: "cancel" },
  { method: "POST", path: "review" },
  { method: "GET", path: "mcp" },
  { method: "POST", path: "mcp/connect" },
];

const PER_IP_PER_MIN = 40;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const mine = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (mine.length >= PER_IP_PER_MIN) return true;
  if (hits.size > 5000) hits.clear();
  hits.set(ip, [...mine, now]);
  return false;
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  ).slice(0, 64);
}

const HEADERS = { "x-content-type-options": "nosniff", "cache-control": "no-store", "referrer-policy": "no-referrer" };

async function handle(req: Request, ctx: { params: Promise<{ p?: string[] }> }) {
  const path = ((await ctx.params).p || []).join("/");
  const method = req.method.toUpperCase();
  if (!RULES.some((r) => r.method === method && r.path === path)) {
    return Response.json({ detail: "Запрещено" }, { status: 403, headers: HEADERS });
  }
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return Response.json({ detail: "Слишком много запросов, подождите минуту" }, { status: 429, headers: HEADERS });
  }
  let body: string | undefined;
  if (method === "POST") {
    body = await req.text();
    if (body.length > 5000) return Response.json({ detail: "Слишком большой запрос" }, { status: 413, headers: HEADERS });
  }
  const search = new URL(req.url).search;
  try {
    const r = await fetch(`${GATEWAY}/${path}${search}`, {
      method,
      body,
      headers: {
        "content-type": "application/json",
        "x-clinic-token": req.headers.get("x-clinic-token") || "",
        "x-clinic-ip": ip,
      },
    });
    return new Response(r.body, {
      status: r.status,
      headers: { ...HEADERS, "content-type": r.headers.get("content-type") || "application/json" },
    });
  } catch {
    return Response.json({ detail: "Кабинет временно недоступен" }, { status: 503, headers: HEADERS });
  }
}

export const GET = handle;
export const POST = handle;
