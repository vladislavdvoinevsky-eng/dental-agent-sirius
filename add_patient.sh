#!/usr/bin/env bash
# Добавить одного пациента в работающую базу, ничего не стирая
source "$(dirname "$0")/tools/common.sh"
"$PY" data/add_patient.py
