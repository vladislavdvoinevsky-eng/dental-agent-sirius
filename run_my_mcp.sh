#!/usr/bin/env bash
# Пример своего MCP-сервера для проверки подключения внешних серверов
source "$(dirname "$0")/tools/common.sh"
"$PY" examples/my_mcp_server.py
