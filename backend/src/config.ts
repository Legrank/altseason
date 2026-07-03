import { existsSync, readFileSync } from 'node:fs'

export interface TelegramBotConfig {
  token: string
  allowedUserIds: Set<string>
  allowedUsernames: Set<string>
  defaultMinThreshold: number
}

export function loadOptionalEnvFiles(paths: string[]): void {
  for (const path of paths) {
    if (!existsSync(path)) {
      continue
    }

    const contents = readFileSync(path, 'utf8')

    for (const rawLine of contents.split(/\r?\n/u)) {
      const line = rawLine.trim()

      if (!line || line.startsWith('#')) {
        continue
      }

      const separatorIndex = line.indexOf('=')

      if (separatorIndex <= 0) {
        continue
      }

      const key = line.slice(0, separatorIndex).trim()
      const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim())

      if (key && process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  }
}

export function readTelegramBotConfig(): TelegramBotConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()

  if (!token) {
    return null
  }

  return {
    token,
    allowedUserIds: parseCsvSet(process.env.TELEGRAM_ALLOWED_USER_IDS),
    allowedUsernames: parseCsvSet(process.env.TELEGRAM_ALLOWED_USERNAMES, true),
    defaultMinThreshold: parseThreshold(process.env.TELEGRAM_DEFAULT_MIN_THRESHOLD)
  }
}

function parseCsvSet(value: string | undefined, normalizeUsername = false): Set<string> {
  const values = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (normalizeUsername ? item.replace(/^@/u, '').toLowerCase() : item))

  return new Set(values)
}

function parseThreshold(value: string | undefined): number {
  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed >= 2 && parsed <= 10 ? parsed : 2
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}
