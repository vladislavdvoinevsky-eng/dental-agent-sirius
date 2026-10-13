"""MCP-сервер медицинской информационной системы (МИС) клиники.
Отдаёт план лечения. patient_id подставляет агент из подтверждённой сессии,
значение от модели игнорируется (см. agent/graph.py, SESSION_BOUND_MCP).
"""
import sqlite3
from pathlib import Path

from mcp.server.fastmcp import FastMCP

DB = Path(__file__).resolve().parent.parent / "data" / "clinic.db"
mcp = FastMCP("clinic-mis", host="127.0.0.1", port=8765)


@mcp.tool()
def get_treatment_plan(patient_id: int) -> str:
    """План лечения подтверждённого пациента. patient_id подставляется автоматически."""
    con = sqlite3.connect(DB)
    rows = con.execute("SELECT diagnosis, plan, cost FROM treatment_plans WHERE patient_id=?",
                       (patient_id,)).fetchall()
    con.close()
    if not rows:
        return "План лечения не найден."
    return "\n".join(f"Диагноз: {d}. План: {p}. Стоимость: {c} руб." for d, p, c in rows)


def mis_key():
    env = DB.parent.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.strip().startswith("MIS_KEY=") and line.split("=", 1)[1].strip():
                return line.split("=", 1)[1].strip()
    return ""


if __name__ == "__main__":
    import sys
    if "--http" not in sys.argv:
        mcp.run(transport="stdio")
    else:
        # Отдельный процесс на 127.0.0.1:8765/mcp. Пускаем только с ключом из .env (заголовок X-MIS-Key):
        # даже если чужой MCP-сервер редиректом заставит агента постучаться сюда, без ключа МИС не ответит
        import hmac

        import uvicorn
        key = mis_key()
        app = mcp.streamable_http_app()

        async def guarded(scope, receive, send):
            if scope["type"] == "http" and key:
                got = dict(scope.get("headers") or []).get(b"x-mis-key", b"").decode()
                if not hmac.compare_digest(got, key):
                    await send({"type": "http.response.start", "status": 403,
                                "headers": [(b"content-type", b"text/plain")]})
                    await send({"type": "http.response.body", "body": b"forbidden"})
                    return
            await app(scope, receive, send)
        uvicorn.run(guarded, host="127.0.0.1", port=8765, log_level="warning")
