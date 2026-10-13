#!/usr/bin/env bash
# Интерфейс чата: Agent Chat UI с GitHub, закреплённый на одной версии, и поверх него
# оформление клиники из ui_patch/overlay. Подключается из install.sh и run.sh после tools/common.sh.
# Версия закреплена, потому что оформление заменяет файлы интерфейса целиком: на другой
# версии Agent Chat UI они могли бы не собраться.
UI_COMMIT="675be8e530d6ecc78ad44f698c5a64d8b0c3c2cc"

ui_pinned() {
  [ -d "$ROOT/ui/.git" ] && [ "$(git -C "$ROOT/ui" rev-parse HEAD 2>/dev/null)" = "$UI_COMMIT" ]
}

# Переводит папку ui на закреплённую версию. Возвращает 0, если версия сменилась и нужен pnpm install.
sync_ui_version() {
  ui_pinned && return 1
  if [ ! -d "$ROOT/ui/.git" ]; then
    if [ -d "$ROOT/ui" ]; then
      # Папка ui без git (скопирована из старой версии): без git не перейти на нужную версию,
      # чат остался бы стандартным, без входа. Убираем её в сторону и скачиваем заново
      local old="ui_old_$(date +%Y%m%d_%H%M%S)"
      warn "В папке ui нет git: скачиваю интерфейс заново (один раз, нужен интернет). Старая папка: $old"
      mv "$ROOT/ui" "$ROOT/$old" || { warn "Не удалось переименовать ui"; return 1; }
    fi
    if ! git clone --depth 1 "$UI_REPO" "$ROOT/ui"; then
      warn "Интерфейс не скачался (нет интернета?)"
      return 1
    fi
  fi
  info "Перевожу интерфейс чата на версию с оформлением клиники (нужен интернет)..."
  if ! git -C "$ROOT/ui" fetch --depth 1 origin "$UI_COMMIT" >/dev/null 2>&1; then
    warn "Не скачалась нужная версия интерфейса. Чат будет в стандартном виде."
    return 1
  fi
  git -C "$ROOT/ui" checkout -f -q "$UI_COMMIT" || { warn "Не переключилась версия интерфейса"; return 1; }
  return 0
}

# Кладёт защитный прокси и оформление клиники поверх ui. Прокси ставится всегда,
# оформление только на закреплённую версию.
install_ui_patch() {
  local ui="$ROOT/ui" patch="$ROOT/ui_patch"
  mkdir -p "$ui/src/app/api/[..._path]"
  cp -f "$patch/route.ts" "$ui/src/app/api/[..._path]/route.ts"
  cp -f "$patch/next.config.mjs" "$ui/next.config.mjs"
  [ -d "$ui/src/lib" ] && cp -f "$patch/resolve-api-url.ts" "$ui/src/lib/resolve-api-url.ts"
  if ! ui_pinned; then
    warn "Интерфейс чата другой версии: оформление клиники не наложено, чат в стандартном виде"
    return 0
  fi
  cp -rf "$patch/overlay/." "$ui/"
}
