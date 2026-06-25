const PUBLIC_IP_WEIGHT_LIMIT_PER_10_SECONDS = 300
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000
const FUTURES_TICKER_PATH = '/api/v1/contract/ticker'

interface MexcFuturesTickerItem {
  symbol: string
  lastPrice: number
}

interface MexcFuturesTickerResponse {
  success: boolean
  code: number
  data: MexcFuturesTickerItem[]
}

interface MexcClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

export class MexcClientError extends Error {
  readonly code: 'cooldown' | 'rate_limit' | 'http' | 'network' | 'parse'
  readonly retryAfterMs: number | null
  readonly statusCode: number | null

  constructor(
    code: 'cooldown' | 'rate_limit' | 'http' | 'network' | 'parse',
    message: string,
    options?: {
      retryAfterMs?: number | null
      statusCode?: number | null
      cause?: unknown
    }
  ) {
    super(message, { cause: options?.cause })
    this.name = 'MexcClientError'
    this.code = code
    this.retryAfterMs = options?.retryAfterMs ?? null
    this.statusCode = options?.statusCode ?? null
  }
}

export class MexcClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private cooldownUntil = 0

  constructor(options: MexcClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://contract.mexc.com'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async getAllUsdtFuturesPrices(): Promise<Map<string, number>> {
    this.assertCooldown()

    let response: Response

    try {
      response = await this.fetchImpl(`${this.baseUrl}${FUTURES_TICKER_PATH}`)
    } catch (error) {
      throw new MexcClientError('network', 'Failed to reach MEXC futures public API.', { cause: error })
    }

    if (response.status === 429 || response.status === 418) {
      const retryAfterMs = this.resolveRetryAfterMs(response.headers.get('Retry-After'))
      this.cooldownUntil = this.now() + retryAfterMs

      throw new MexcClientError(
        'rate_limit',
        `MEXC futures public API rate limit reached for IP-weighted endpoints (${PUBLIC_IP_WEIGHT_LIMIT_PER_10_SECONDS} weight / 10 seconds).`,
        {
          retryAfterMs,
          statusCode: response.status
        }
      )
    }

    if (!response.ok) {
      throw new MexcClientError('http', `Unexpected MEXC response: ${response.status}.`, {
        statusCode: response.status
      })
    }

    let payload: unknown

    try {
      payload = await response.json()
    } catch (error) {
      throw new MexcClientError('parse', 'Failed to parse MEXC futures ticker response.', { cause: error })
    }

    if (!this.isValidFuturesTickerResponse(payload)) {
      throw new MexcClientError('parse', 'Unexpected MEXC futures ticker payload shape.')
    }

    const prices = new Map<string, number>()

    for (const item of payload.data) {
      if (typeof item?.symbol !== 'string' || typeof item?.lastPrice !== 'number') {
        continue
      }

      if (!Number.isFinite(item.lastPrice)) {
        continue
      }

      prices.set(item.symbol, item.lastPrice)
    }

    return prices
  }

  private assertCooldown(): void {
    const now = this.now()

    if (now < this.cooldownUntil) {
      throw new MexcClientError('cooldown', 'MEXC client is waiting for Retry-After cooldown.', {
        retryAfterMs: this.cooldownUntil - now
      })
    }
  }

  private resolveRetryAfterMs(retryAfterHeader: string | null): number {
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000
    }

    return DEFAULT_RATE_LIMIT_COOLDOWN_MS
  }

  private isValidFuturesTickerResponse(payload: unknown): payload is MexcFuturesTickerResponse {
    if (typeof payload !== 'object' || payload === null) {
      return false
    }

    const data = Reflect.get(payload, 'data')
    const success = Reflect.get(payload, 'success')
    const code = Reflect.get(payload, 'code')

    return Array.isArray(data) && typeof success === 'boolean' && typeof code === 'number'
  }
}
