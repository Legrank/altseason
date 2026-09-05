import { CoingeckoClientError } from '../integrations/coingecko/index.js'
import type { CoingeckoCoin, CoingeckoTicker } from '../integrations/coingecko/index.js'
import type { CardRepository } from '../repository.js'
import type { CoingeckoListingInput } from '../types.js'
import { buildSymbolCandidates } from './symbol-aliases.js'

interface Logger {
  info(context: Record<string, unknown>, message: string): void
  warn(context: Record<string, unknown>, message: string): void
  error(context: Record<string, unknown>, message: string): void
}

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {}
}

export const COINGECKO_LISTING_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETRY_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_DAILY_COIN_BUDGET = 100
const COIN_INDEX_TTL_MS = 24 * 60 * 60 * 1000

interface CoingeckoListingProvider {
  getCoinsList(): Promise<CoingeckoCoin[]>
  getTopCoinsByMarketCap(pages?: number): Promise<CoingeckoCoin[]>
  getCoinTickers(coinId: string): Promise<CoingeckoTicker[]>
}

export interface CoingeckoListingSyncResult {
  processedSymbols: number
  resolvedSymbols: number
  listingCount: number
}

interface CoingeckoListingSyncServiceOptions {
  repository: CardRepository
  coingeckoClient: CoingeckoListingProvider
  /** Cards enriched per run. One card costs one to two CoinGecko calls. */
  dailyCoinBudget?: number
  intervalMs?: number
  retryIntervalMs?: number
  now?: () => Date
  logger?: Logger
}

interface CoinIndex {
  builtAtMs: number
  /** Ticker symbol -> coin id, resolved by market-cap rank where a symbol is ambiguous. */
  bySymbol: Map<string, string>
}

/**
 * Enriches cards with venues the direct exchange clients do not cover, using CoinGecko.
 *
 * CoinGecko charges one credit per call and the free Demo plan allows 10k calls a month,
 * so the whole catalog is never fetched at once: each run spends a fixed budget on the
 * cards whose aggregator data is oldest, and the catalog rotates through over several days.
 */
export class CoingeckoListingSyncService {
  private readonly repository: CardRepository
  private readonly coingeckoClient: CoingeckoListingProvider
  private readonly dailyCoinBudget: number
  private readonly intervalMs: number
  private readonly retryIntervalMs: number
  private readonly now: () => Date
  private readonly logger: Logger
  private coinIndex: CoinIndex | null = null
  private timer: NodeJS.Timeout | null = null
  private started = false
  private inProgress = false

  constructor(options: CoingeckoListingSyncServiceOptions) {
    this.repository = options.repository
    this.coingeckoClient = options.coingeckoClient
    this.dailyCoinBudget = options.dailyCoinBudget ?? DEFAULT_DAILY_COIN_BUDGET
    this.intervalMs = options.intervalMs ?? COINGECKO_LISTING_SYNC_INTERVAL_MS
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? noopLogger
  }

  start(): void {
    if (this.started) {
      return
    }

    this.started = true
    this.schedule(0)
  }

  stop(): void {
    this.started = false

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async syncNow(): Promise<CoingeckoListingSyncResult | null> {
    if (this.inProgress) {
      return null
    }

    this.inProgress = true

    try {
      const symbols = this.repository.getStaleCoingeckoSymbols(this.dailyCoinBudget)

      if (symbols.length === 0) {
        return { processedSymbols: 0, resolvedSymbols: 0, listingCount: 0 }
      }

      const index = await this.getCoinIndex()
      let processedSymbols = 0
      let resolvedSymbols = 0
      let listingCount = 0

      for (const symbol of symbols) {
        const syncedAt = this.now().toISOString()
        const coinId = this.resolveCoinId(symbol, index)

        if (coinId === null) {
          // Record the attempt anyway so an unresolvable symbol does not block the rotation.
          this.repository.replaceCoingeckoListings(symbol, null, [], syncedAt)
          processedSymbols += 1
          continue
        }

        try {
          const tickers = await this.coingeckoClient.getCoinTickers(coinId)
          listingCount += this.repository.replaceCoingeckoListings(
            symbol,
            coinId,
            this.toListings(tickers),
            syncedAt
          )
          processedSymbols += 1
          resolvedSymbols += 1
        } catch (error) {
          if (error instanceof CoingeckoClientError && (error.code === 'rate_limit' || error.code === 'cooldown')) {
            // Stop the run instead of burning the remaining budget against a closed door.
            this.logger.warn(
              { err: error, symbol, processedSymbols },
              'CoinGecko listing synchronization stopped early on a rate limit.'
            )
            break
          }

          this.logger.warn({ err: error, symbol }, 'CoinGecko listing synchronization failed for one symbol.')
        }
      }

      this.logger.info(
        { processedSymbols, resolvedSymbols, listingCount, budget: this.dailyCoinBudget },
        'CoinGecko listing synchronization completed.'
      )

      return { processedSymbols, resolvedSymbols, listingCount }
    } catch (error) {
      this.logger.error({ err: error }, 'CoinGecko listing synchronization failed.')
      return null
    } finally {
      this.inProgress = false
    }
  }

  private toListings(tickers: readonly CoingeckoTicker[]): CoingeckoListingInput[] {
    const byExchange = new Map<string, CoingeckoListingInput>()

    for (const ticker of tickers) {
      if (ticker.isStale) {
        continue
      }

      const existing = byExchange.get(ticker.exchangeId)

      // One venue can list a coin against many quotes; keep its deepest market.
      if (existing !== undefined && (existing.volumeUsd24h ?? 0) >= (ticker.volumeUsd ?? 0)) {
        continue
      }

      byExchange.set(ticker.exchangeId, {
        exchange: ticker.exchangeId,
        label: ticker.exchangeName,
        // The coin tickers endpoint reports spot markets; CoinGecko keeps derivatives elsewhere.
        marketType: 'spot',
        pair: `${ticker.base}/${ticker.target}`,
        tradeUrl: ticker.tradeUrl,
        volumeUsd24h: ticker.volumeUsd
      })
    }

    return [...byExchange.values()]
  }

  private resolveCoinId(symbol: string, index: CoinIndex): string | null {
    for (const candidate of buildSymbolCandidates(symbol)) {
      const coinId = index.bySymbol.get(candidate)

      if (coinId !== undefined) {
        return coinId
      }
    }

    return null
  }

  private async getCoinIndex(): Promise<CoinIndex> {
    const nowMs = this.now().getTime()

    if (this.coinIndex !== null && nowMs - this.coinIndex.builtAtMs < COIN_INDEX_TTL_MS) {
      return this.coinIndex
    }

    const [topCoins, allCoins] = await Promise.all([
      this.coingeckoClient.getTopCoinsByMarketCap(),
      this.coingeckoClient.getCoinsList()
    ])
    const symbolCounts = new Map<string, number>()

    for (const coin of allCoins) {
      symbolCounts.set(coin.symbol, (symbolCounts.get(coin.symbol) ?? 0) + 1)
    }

    // Unambiguous tickers resolve directly; ambiguous ones are settled by market-cap rank,
    // and a ticker that is both ambiguous and outside the ranking is left unresolved rather
    // than guessed, so a card never shows another coin's venues.
    const bySymbol = new Map<string, string>()

    for (const coin of allCoins) {
      if (symbolCounts.get(coin.symbol) === 1) {
        bySymbol.set(coin.symbol, coin.id)
      }
    }

    // getTopCoinsByMarketCap returns rank order, so the first entry for a symbol is the
    // highest-capitalised coin carrying it and must not be overwritten by a lower-ranked one.
    const rankedSymbols = new Set<string>()

    for (const coin of topCoins) {
      if (rankedSymbols.has(coin.symbol)) {
        continue
      }

      rankedSymbols.add(coin.symbol)
      bySymbol.set(coin.symbol, coin.id)
    }

    this.coinIndex = { builtAtMs: nowMs, bySymbol }

    return this.coinIndex
  }

  private schedule(delayMs: number): void {
    if (!this.started) {
      return
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.runScheduledSync()
    }, delayMs)
  }

  private async runScheduledSync(): Promise<void> {
    const result = await this.syncNow()

    if (!this.started) {
      return
    }

    this.schedule(result === null ? this.retryIntervalMs : this.intervalMs)
  }
}
