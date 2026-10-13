#!/usr/bin/env bash
# Остановить все службы агента (чат, шлюз, агент, админка, МИС, туннель):  bash stop.sh
source "$(dirname "$0")/tools/common.sh"
stop_old
ok "Готово: службы агента остановлены, порты свободны."
