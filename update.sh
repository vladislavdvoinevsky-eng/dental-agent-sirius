#!/usr/bin/env bash
# Обновление: переносит настройки и данные из старой папки агента в эту (новую), затем доустанавливает.
# Запуск из НОВОЙ папки:  bash update.sh   (или bash update.sh /путь/к/старой/папке)
# Старая папка не меняется и не удаляется.
source "$(dirname "$0")/tools/common.sh"
echo -e "${Y}=== Обновление агента клиники до версии $(cat VERSION) ===${N}"
echo "Новая папка: $ROOT"

step "1/4 Ищу предыдущую версию"
OLD="$1"
if [ -z "$OLD" ]; then
  mapfile -t FOUND < <(
    for r in "$HOME" "$HOME/Desktop" "$HOME/Рабочий стол" "$HOME/Downloads" "$HOME/Загрузки" "$HOME/Documents" \
             "$HOME/Документы" "$(dirname "$ROOT")" "$(dirname "$(dirname "$ROOT")")"; do
      [ -d "$r" ] || continue
      find "$r" -maxdepth 3 -type f -path '*/agent/graph.py' 2>/dev/null
    done | sed 's#/agent/graph.py$##' | sort -u | while read -r d; do
      [ "$d" = "$ROOT" ] && continue
      [ -f "$d/.env" ] || [ -f "$d/data/clinic.db" ] || continue
      echo "$(stat -c %Y "$d/data/clinic.db" 2>/dev/null || echo 0) $d"
    done | sort -rn | cut -d' ' -f2-)
  if [ ${#FOUND[@]} -eq 0 ]; then
    read -r -p "Старая версия не найдена. Путь к старой папке (Enter = чистая установка): " OLD
  else
    echo "Найдены версии (сверху самая свежая по базе):"
    for i in "${!FOUND[@]}"; do echo "  $((i + 1))) ${FOUND[$i]}"; done
    read -r -p "Из какой переносить? Enter = 1, 0 = ничего не переносить: " ans
    ans=${ans:-1}
    if [[ "$ans" =~ ^[0-9]+$ ]] && [ "$ans" -ge 1 ] && [ "$ans" -le ${#FOUND[@]} ]; then OLD="${FOUND[$((ans - 1))]}"
    elif [ "$ans" != 0 ]; then OLD="$ans"; fi
  fi
fi
if [ -n "$OLD" ]; then
  [ -f "$OLD/agent/graph.py" ] || fail "В папке $OLD нет агента"
  ok "Переношу из: $OLD"
else
  info "Переносить нечего, будет чистая установка"
fi

step "2/4 Останавливаю запущенного агента"
stop_old

if [ -n "$OLD" ]; then
  step "3/4 Настройки и данные"
  if [ -f "$OLD/.env" ]; then
    sed 's/\r$//' "$OLD/.env" > .env
    added=""
    while IFS= read -r line; do
      k=$(echo "$line" | sed -nE 's/^\s*([A-Z_]+)\s*=.*/\1/p')
      [ -n "$k" ] && ! grep -q "^$k\s*=" .env && { echo "$line" >> .env; added="$added $k"; }
    done < .env.example
    ok "Настройки перенесены. Новые параметры:${added:- нет}"
  fi
  for f in branches.csv doctors.csv staff.csv patients.csv treatment_plans.csv reviews.csv kb.csv services.csv; do
    [ -f "$OLD/data/$f" ] || continue
    # kb.csv в новой версии мог пополниться: берём старый, только если он длиннее нового
    if [ "$f" = kb.csv ] && [ "$(stat -c %s "$OLD/data/$f")" -lt "$(stat -c %s "data/$f")" ]; then
      info "kb.csv: оставляю новый (в нём больше статей)"; continue
    fi
    cp -f "$OLD/data/$f" "data/$f" && info "перенесён $f"
  done
  if [ -f "$OLD/data/clinic.db" ]; then cp -f "$OLD/data/clinic.db" data/clinic.db && ok "База перенесена: записи, журналы и пациенты сохранены"; fi
  for f in tools/cloudflared tools/tunnel_key tools/tunnel_key.pub; do
    [ -f "$OLD/$f" ] && [ ! -f "$f" ] && cp -f "$OLD/$f" "$f" && info "перенесён $f"
  done
  # Node.js и Ollama, поставленные без sudo в старую папку, переносим, чтобы не качать заново
  for d in .node .ollama; do
    [ -d "$OLD/$d" ] && [ ! -d "$d" ] && cp -a "$OLD/$d" "$d" && info "перенесена папка $d"
  done
  # Интерфейс без node_modules и сборки: так быстрее, чем качать с GitHub
  if [ ! -d ui ] && [ -d "$OLD/ui/.git" ]; then
    info "Копирую интерфейс из старой папки"
    mkdir -p ui && (cd "$OLD/ui" && tar --exclude=./node_modules --exclude=./.next -cf - .) | (cd ui && tar -xf -)
  fi
fi

step "4/4 Доустановка (install.sh: уже установленное пропускается)"
bash "$ROOT/install.sh"
