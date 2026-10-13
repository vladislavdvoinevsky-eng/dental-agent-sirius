#!/usr/bin/env bash
# Запуск с доступом через интернет (если Wi-Fi университета не пускает компьютеры друг к другу)
exec bash "$(dirname "$0")/run.sh" --internet
