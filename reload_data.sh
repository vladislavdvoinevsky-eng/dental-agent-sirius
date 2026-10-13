#!/usr/bin/env bash
# Пересобрать базу из таблиц data/*.csv С НУЛЯ: записи на приём и журналы стираются
source "$(dirname "$0")/tools/common.sh"
read -r -p "База будет создана заново, записи и журналы сотрутся. Продолжить? [д/Н]: " a
case "$a" in д|Д|y|Y|да) "$PY" data/load_data.py ;; *) echo "Отменено" ;; esac
