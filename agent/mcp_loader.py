"""Подключение MCP-серверов из mcp_servers.json.
Чтобы добавить внешний MCP-сервер, допиши его в mcp_servers.json, например:
  "github": {"url": "https://example.com/mcp", "transport": "streamable_http"}
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_cache = None


def _config():
    # МИС запускается run.sh отдельным процессом по HTTP (127.0.0.1:8765) и закрыт ключом MIS_KEY
    name = "mcp_servers.json"
    cfg = json.loads((ROOT / name).read_text(encoding="utf-8"))
    from agent.db import env_value
    key = env_value("MIS_KEY")
    for name, c in cfg.items():
        if name == "clinic_mis" and c.get("url") and key:
            c["headers"] = {"X-MIS-Key": key}
        if c.get("command") == "python":
            c["command"] = sys.executable
            c["args"] = [str(ROOT / a) if a.endswith(".py") else a for a in c.get("args", [])]
    return cfg


async def get_mcp_tools():
    global _cache
    if _cache is not None:
        return _cache
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
        client = MultiServerMCPClient(_config())
        _cache = await client.get_tools()
        print(f"[MCP] подключены инструменты: {[t.name for t in _cache]}", flush=True)
    except Exception as e:
        print(f"[MCP] не удалось подключить серверы: {e}", flush=True)
        return []
    return _cache
