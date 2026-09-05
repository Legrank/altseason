const DEFAULT_PUBLIC_BASE_URL = 'https://api.coingecko.com/api/v3'
const DEFAULT_PRO_BASE_URL = 'https://pro-api.coingecko.com/api/v3'
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000
const TICKERS_PAGE_SIZE = 100
const DEFAULT_MAX_TICKER_PAGES = 3

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

export interface CoingeckoCoin {
  id: string
  symbol: string
  name: string
}

export interface CoingeckoTicker {
  exchangeId: string
  exchangeName: string
  base: string
  target: string
  tradeUrl: string | null
  volumeUsd: number | null
  trustScore: string | null
  isStale: boolean
}

export interface CoingeckoClientOptions {
  apiKey?: string | null
  /** A "pro" key authenticates against a different host and header than a demo key. */
  apiKeyKind?: 'demo' | 'pro'
  baseUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  maxTickerPages?: number
}

/**
 * Read-only wrapper over the CoinGecko public API. Only the two endpoints the listing
 * sync needs are exposed; nothing else in the codebase may call coingecko.com directly.
 */
export class CoingeckoClient {
  private readonly apiKey: string | null
  private readonly apiKeyKind: 'demo' | 'pro'
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly maxTickerPages: number
  private cooldownUntil = 0

  constructor(options: CoingeckoClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null
    this.apiKeyKind = options.apiKeyKind ?? 'demo'
    this.baseUrl =
      options.baseUrl ??
      (this.apiKey !== null && this.apiKeyKind === 'pro' ? DEFAULT_PRO_BASE_URL : DEFAULT_PUBLIC_BASE_URL)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.maxTickerPages = options.maxTickerPages ?? DEFAULT_MAX_TICKER_PAGES
  }

  async getCoinsList(): Promise<CoingeckoCoin[]> {
    const payload = await this.requestJson('/coins/list', 'Failed to parse the CoinGecko coin list response.')

    if (!Array.isArray(payload)) {
      throw new CoingeckoClientError('parse', 'Unexpected CoinGecko coin list payload shape.')
    }

    return payload.flatMap((item) => {
      const id = readString(item, 'id')
      const symbol = readString(item, 'symbol').toUpperCase()

      if (!id || !symbol) {
        return []
      }

      return [{ id, symbol, name: readString(item, 'name') }]
    })
  }

  /**
   * The highest-market-cap coins, in rank order. A ticker symbol is not unique on CoinGecko,
   * so this ranking is what lets the listing sync pick the coin a card actually means.
   */
  async getTopCoinsByMarketCap(pages = 4): Promise<CoingeckoCoin[]> {
    const coins: CoingeckoCoin[] = []

    for (let page = 1; page <= pages; page += 1) {
      const payload = await this.requestJson(
        `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`,
        'Failed to parse the CoinGecko markets response.'
      )

      if (!Array.isArray(payload)) {
        throw new CoingeckoClientError('parse', 'Unexpected CoinGecko markets payload shape.')
      }

      for (const item of payload) {
        const id = readString(item, 'id')
        const symbol = readString(item, 'symbol').toUpperCase()

        if (id && symbol) {
          coins.push({ id, symbol, name: readString(item, 'name') })
        }
      }

      if (payload.length < 250) {
        break
      }
    }

    return coins
  }

  /**
   * Walks the paginated ticker list for one coin. CoinGecko caps a page at 100 tickers and
   * exposes no total count on the JSON body, so a short page ends the walk.
   */
  async getCoinTickers(coinId: string): Promise<CoingeckoTicker[]> {
    const tickers: CoingeckoTicker[] = []

    for (let page = 1; page <= this.maxTickerPages; page += 1) {
      const payload = await this.requestJson(
        `/coins/${encodeURIComponent(coinId)}/tickers?page=${page}&depth=false`,
        'Failed to parse the CoinGecko coin tickers response.'
      )

      if (typeof payload !== 'object' || payload === null) {
        throw new CoingeckoClientError('parse', 'Unexpected CoinGecko coin tickers payload shape.')
      }

      const rawTickers = Reflect.get(payload, 'tickers')

      if (!Array.isArray(rawTickers)) {
        throw new CoingeckoClientError('parse', 'Unexpected CoinGecko coin tickers payload shape.')
      }

      for (const item of rawTickers) {
        const ticker = this.parseTicker(item)

        if (ticker !== null) {
          tickers.push(ticker)
        }
      }

      if (rawTickers.length < TICKERS_PAGE_SIZE) {
        break
      }
    }

    return tickers
  }

  private parseTicker(item: unknown): CoingeckoTicker | null {
    if (typeof item !== 'object' || item === null) {
      return null
    }

    const market = Reflect.get(item, 'market')
    const exchangeId = readString(market, 'identifier')
    const exchangeName = readString(market, 'name')
    const base = readString(item, 'base').toUpperCase()
    const target = readString(item, 'target').toUpperCase()

    if (!exchangeId || !base || !target) {
      return null
    }

    const convertedVolume = Reflect.get(item, 'converted_volume')
    const volumeUsd = parseFiniteNumber(
      typeof convertedVolume === 'object' && convertedVolume !== null
        ? Reflect.get(convertedVolume, 'usd')
        : undefined
    )
    const trustScore = Reflect.get(item, 'trust_score')
    const tradeUrl = readString(item, 'trade_url')

    return {
      exchangeId,
      exchangeName: exchangeName || exchangeId,
      base,
      target,
      tradeUrl: tradeUrl || null,
      volumeUsd,
      trustScore: typeof trustScore === 'string' ? trustScore : null,
      isStale: Reflect.get(item, 'is_stale') === true
    }
  }

  private async requestJson(path: string, parseErrorMessage: string): Promise<unknown> {
    const now = this.now()

    if (now < this.cooldownUntil) {
      throw new CoingeckoClientError('cooldown', 'CoinGecko client is waiting for Retry-After cooldown.', {
        retryAfterMs: this.cooldownUntil - now
      })
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

function readString(payload: unknown, key: string): string {
  if (typeof payload !== 'object' || payload === null) {
    return ''
  }

  const value = Reflect.get(payload, key)

  return typeof value === 'string' ? value.trim() : ''
}

function parseFiniteNumber(value: unknown): number | null {
  const numericValue =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN

  return Number.isFinite(numericValue) ? numericValue : null
}
