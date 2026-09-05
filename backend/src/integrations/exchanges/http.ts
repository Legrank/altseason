const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000

export type ExchangeClientErrorCode = 'cooldown' | 'rate_limit' | 'http' | 'network' | 'parse'

export class ExchangeClientError extends Error {
  readonly code: ExchangeClientErrorCode
  readonly exchangeId: string
  readonly retryAfterMs: number | null
  readonly statusCode: number | null

  constructor(
    exchangeId: string,
    code: ExchangeClientErrorCode,
    message: string,
    options?: {
      retryAfterMs?: number | null
      statusCode?: number | null
      cause?: unknown
    }
  ) {
    super(message, { cause: options?.cause })
    this.name = 'ExchangeClientError'
    this.exchangeId = exchangeId
    this.code = code
    this.retryAfterMs = options?.retryAfterMs ?? null
    this.statusCode = options?.statusCode ?? null
  }
}

/**
 * Shared transport for the public listing endpoints of every supported exchange.
 * Mirrors the MEXC client policy: a 429/418 response starts a cooldown and the
 * client fails fast instead of retrying while that cooldown is active.
 */
export class ExchangeHttpClient {
  private readonly exchangeId: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private cooldownUntil = 0

  constructor(exchangeId: string, options: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
    this.exchangeId = exchangeId
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async getJson(url: string, parseErrorMessage: string): Promise<unknown> {
    this.assertCooldown()

    let response: Response

    try {
      response = await this.fetchImpl(url)
    } catch (error) {
      throw new ExchangeClientError(
        this.exchangeId,
        'network',
        `Failed to reach the ${this.exchangeId} public API.`,
        { cause: error }
      )
    }

    if (response.status === 429 || response.status === 418) {
      const retryAfterMs = this.resolveRetryAfterMs(response.headers.get('Retry-After'))
      this.cooldownUntil = this.now() + retryAfterMs

      throw new ExchangeClientError(
        this.exchangeId,
        'rate_limit',
        `${this.exchangeId} public API rate limit reached for ${url}.`,
        { retryAfterMs, statusCode: response.status }
      )
    }

    if (!response.ok) {
      throw new ExchangeClientError(
        this.exchangeId,
        'http',
        `Unexpected ${this.exchangeId} response: ${response.status}.`,
        { statusCode: response.status }
      )
    }

    try {
      return await response.json()
    } catch (error) {
      throw new ExchangeClientError(this.exchangeId, 'parse', parseErrorMessage, { cause: error })
    }
  }

  parseError(message: string): ExchangeClientError {
    return new ExchangeClientError(this.exchangeId, 'parse', message)
  }

  private assertCooldown(): void {
    const now = this.now()

    if (now < this.cooldownUntil) {
      throw new ExchangeClientError(
        this.exchangeId,
        'cooldown',
        `${this.exchangeId} client is waiting for Retry-After cooldown.`,
        { retryAfterMs: this.cooldownUntil - now }
      )
    }
  }

  private resolveRetryAfterMs(retryAfterHeader: string | null): number {
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000
    }

    return DEFAULT_RATE_LIMIT_COOLDOWN_MS
  }
}

export function readArrayPayload(
  http: ExchangeHttpClient,
  payload: unknown,
  path: string | null,
  message: string
): unknown[] {
  const candidate = path === null ? payload : readProperty(payload, path)

  if (!Array.isArray(candidate)) {
    throw http.parseError(message)
  }

  return candidate
}

function readProperty(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) {
    return undefined
  }

  return Reflect.get(payload, key)
}

export function readString(item: unknown, key: string): string {
  const value = readProperty(item, key)

  return typeof value === 'string' ? value.trim() : ''
}
