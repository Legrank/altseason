const PUBLIC_IP_WEIGHT_LIMIT_PER_10_SECONDS = 300
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000
const FUTURES_TICKER_PATH = '/api/v1/contract/ticker'
const FUTURES_KLINE_PATH_PREFIX = '/api/v1/contract/kline/'
const DAILY_KLINE_INTERVAL = 'Day1'

interface MexcFuturesTickerItem {
  symbol: string
  lastPrice: number
}

interface MexcResponseEnvelope {
  success: boolean
  code: number
  data: unknown
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
    const payload = await this.requestJson(FUTURES_TICKER_PATH, 'Failed to parse MEXC futures ticker response.')

    if (!this.isValidResponseEnvelope(payload) || !Array.isArray(payload.data)) {
      throw new MexcClientError('parse', 'Unexpected MEXC futures ticker payload shape.')
    }

    const prices = new Map<string, number>()

    for (const item of payload.data as MexcFuturesTickerItem[]) {
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

  async getUsdtFuturesDailyAmounts(symbol: string, limit = 90): Promise<number[]> {
    const payload = await this.requestJson(
      `${FUTURES_KLINE_PATH_PREFIX}${encodeURIComponent(symbol)}?interval=${DAILY_KLINE_INTERVAL}`,
      'Failed to parse MEXC futures kline response.'
    )

    if (!this.isValidResponseEnvelope(payload)) {
      throw new MexcClientError('parse', 'Unexpected MEXC futures kline payload shape.')
    }

    const amounts = this.extractDailyAmounts(payload.data)

    if (amounts === null) {
      throw new MexcClientError('parse', 'Unexpected MEXC futures kline payload shape.')
    }

    return amounts.slice(-limit)
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

  private isValidResponseEnvelope(payload: unknown): payload is MexcResponseEnvelope {
    if (typeof payload !== 'object' || payload === null) {
      return false
    }

    const success = Reflect.get(payload, 'success')
    const code = Reflect.get(payload, 'code')

    return 'data' in payload && typeof success === 'boolean' && typeof code === 'number'
  }

  private async requestJson(path: string, parseErrorMessage: string): Promise<unknown> {
    this.assertCooldown()

    let response: Response

    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`)
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

    try {
      return await response.json()
    } catch (error) {
      throw new MexcClientError('parse', parseErrorMessage, { cause: error })
    }
  }

  private extractDailyAmounts(data: unknown): number[] | null {
    if (Array.isArray(data)) {
      return data.flatMap((item) => {
        if (typeof item !== 'object' || item === null) {
          return []
        }

        const amount = this.parseFiniteNumber(Reflect.get(item, 'amount'))
        return amount === null ? [] : [amount]
      })
    }

    if (typeof data !== 'object' || data === null) {
      return null
    }

    const rawAmounts = Reflect.get(data, 'amount')

    if (!Array.isArray(rawAmounts)) {
      return null
    }

    return rawAmounts.flatMap((value) => {
      const amount = this.parseFiniteNumber(value)
      return amount === null ? [] : [amount]
    })
  }

  private parseFiniteNumber(value: unknown): number | null {
    const numericValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN

    return Number.isFinite(numericValue) ? numericValue : null
  }
}
