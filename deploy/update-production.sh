#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DEPLOY_WAIT_TIMEOUT="${DEPLOY_WAIT_TIMEOUT:-120}"

log() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf 'Ошибка: %s\n' "$1" >&2
  exit 1
}

env_has_value() {
  local key="$1"

  tr -d '\r' < "${ENV_FILE}" | grep -Eq "^${key}=[^[:space:]]+$"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "не найдена команда '$1'."
}

trap 'printf "\nОбновление остановлено (строка %s).\n" "$LINENO" >&2' ERR

require_command git
require_command docker

[[ "${DEPLOY_WAIT_TIMEOUT}" =~ ^[1-9][0-9]*$ ]] ||
  fail 'DEPLOY_WAIT_TIMEOUT должен быть положительным целым числом.'

cd "${PROJECT_ROOT}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  fail "${PROJECT_ROOT} не является Git-репозиторием."

docker compose version >/dev/null 2>&1 ||
  fail "требуется Docker Compose v2 (команда 'docker compose')."

ENV_FILE="${PROJECT_ROOT}/backend/.env.local"

[[ -f "${ENV_FILE}" ]] ||
  fail "не найден ${ENV_FILE}; обновление без Telegram-конфигурации запрещено."

env_has_value TELEGRAM_BOT_TOKEN ||
  fail 'в backend/.env.local отсутствует TELEGRAM_BOT_TOKEN.'

if ! env_has_value TELEGRAM_ALLOWED_USER_IDS && ! env_has_value TELEGRAM_ALLOWED_USERNAMES; then
  fail 'в backend/.env.local должен быть заполнен Telegram allowlist.'
fi

if [[ -n "$(git status --porcelain)" ]]; then
  fail 'рабочее дерево содержит незакоммиченные изменения. Сохраните или отмените их перед обновлением.'
fi

CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD)" ||
  fail 'репозиторий находится в detached HEAD. Переключитесь на продакшен-ветку.'

git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1 ||
  fail "для ветки ${CURRENT_BRANCH} не настроена upstream-ветка."

BEFORE_REVISION="$(git rev-parse --short HEAD)"

log "Получение обновлений для ветки ${CURRENT_BRANCH}"
git pull --ff-only

AFTER_REVISION="$(git rev-parse --short HEAD)"
printf 'Версия: %s -> %s\n' "${BEFORE_REVISION}" "${AFTER_REVISION}"

log 'Проверка конфигурации Docker Compose'
docker compose config --quiet

log 'Сборка продакшен-образов'
docker compose build --pull

log 'Обновление контейнеров и ожидание готовности'
docker compose up \
  --detach \
  --remove-orphans \
  --wait \
  --wait-timeout "${DEPLOY_WAIT_TIMEOUT}"

log 'Продакшен успешно обновлён'
docker compose ps
