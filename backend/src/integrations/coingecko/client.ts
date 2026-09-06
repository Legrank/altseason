const DEFAULT_PUBLIC_BASE_URL = 'https://api.coingecko.com/api/v3'
const DEFAULT_PRO_BASE_URL = 'https://pro-api.coingecko.com/api/v3'
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000

export type CoingeckoClientErrorCode = 'cooldown' | 'rate_limit' | 'http' | 'network' | 'parse'

export class CoingeckoClientError extends Error {
  readonly code: CoingeckoClientErrorCode
  readonly retryAfterMs: number | null
  readonly statusCode: number | null

  constructor(
    code: CoingeckoClientErrorCode,
    message: string,
    options?: { retryAfterMs?: number | null; statusCode?: number | null; cause?: unknown }
  ) {
    super(message, { cause: options?.cause })
    this.name = 'CoingeckoClientError'
    this.code = code
    this.retryAfterMs = options?.retryAfterMs ?? null
    this.statusCode = options?.statusCode ?? null
  }
}

export interface CoingeckoPerpetual {
  /** Venue name as CoinGecko reports it, e.g. "Binance (Futures)". */
  market: string
  /** Venue-native contract symbol, e.g. "BTCUSDT". */
  symbol: string
  /** Underlying asset ticker, e.g. "BTC". CoinGecko resolves this itself. */
  indexId: string
  openInterest: number | null
  volume24h: number | null
}

export interface CoingeckoClientOptions {
  apiKey?: string | null
  /** A "pro" key authenticates against a different host and header than a demo key. */
  apiKeyKind?: 'demo' | 'pro'
  baseUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Read-only wrapper over the CoinGecko public API. Only the endpoint the listing sync
 * needs is exposed; nothing else in the codebase may call coingecko.com directly.
 */
export class CoingeckoClient {
  private readonly apiKey: string | null
  private readonly apiKeyKind: 'demo' | 'pro'
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private cooldownUntil = 0

  constructor(options: CoingeckoClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null
    this.apiKeyKind = options.apiKeyKind ?? 'demo'
    this.baseUrl =
      options.baseUrl ??
      (this.apiKey !== null && this.apiKeyKind === 'pro'
        ? DEFAULT_PRO_BASE_URL
        : DEFAULT_PUBLIC_BASE_URL)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  /**
   * Every perpetual contract CoinGecko tracks, across every derivatives venue, in one call.
   * Dated futures are filtered out; only perpetuals are comparable to a MEXC perpetual card.
   */
  async getPerpetualDerivatives(): Promise<CoingeckoPerpetual[]> {
    const payload = await this.requestJson(
      '/derivatives',
      'Failed to parse the CoinGecko derivatives response.'
    )

    if (!Array.isArray(payload)) {
      throw new CoingeckoClientError('parse', 'Unexpected CoinGecko derivatives payload shape.')
    }

    return payload.flatMap((item) => {
      if (readString(item, 'contract_type') !== 'perpetual') {
        return []
      }

      const market = readString(item, 'market')
      const indexId = readString(item, 'index_id').toUpperCase()
      const symbol = readString(item, 'symbol')

      if (!market || !indexId) {
        return []
      }

      return [
        {
          market,
          symbol,
          indexId,
          openInterest: parseFiniteNumber(readProperty(item, 'open_interest')),
          volume24h: parseFiniteNumber(readProperty(item, 'volume_24h'))
        }
      ]
    })
  }

  private async requestJson(path: string, parseErrorMessage: string): Promise<unknown> {
    const now = this.now()

    if (now < this.cooldownUntil) {
      throw new CoingeckoClientError(
        'cooldown',
        'CoinGecko client is waiting for Retry-After cooldown.',
        { retryAfterMs: this.cooldownUntil - now }
      )
    }

    const headers = new Headers({ accept: 'application/json' })

    if (this.apiKey !== null) {
      headers.set(this.apiKeyKind === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key', this.apiKey)
    }

    let response: Response

    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers })
    } catch (error) {
      throw new CoingeckoClientError('network', 'Failed to reach the CoinGecko public API.', {
        cause: error
      })
    }

    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get('Retry-After'))
      const retryAfterMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : DEFAULT_RATE_LIMIT_COOLDOWN_MS
      this.cooldownUntil = this.now() + retryAfterMs

      throw new CoingeckoClientError('rate_limit', `CoinGecko rate limit reached for ${path}.`, {
        retryAfterMs,
        statusCode: response.status
      })
    }

    if (!response.ok) {
      throw new CoingeckoClientError('http', `Unexpected CoinGecko response: ${response.status}.`, {
        statusCode: response.status
      })
    }

    try {
      return await response.json()
    } catch (error) {
      throw new CoingeckoClientError('parse', parseErrorMessage, { cause: error })
    }
  }
}

function readProperty(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) {
    return undefined
  }

  return Reflect.get(payload, key)
}

function readString(payload: unknown, key: string): string {
  const value = readProperty(payload, key)

  return typeof value === 'string' ? value.trim() : ''
}

function parseFiniteNumber(value: unknown): number | null {
  const numericValue =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN

  return Number.isFinite(numericValue) ? numericValue : null
}
