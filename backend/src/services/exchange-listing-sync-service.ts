import type { ExchangeListingProvider } from '../integrations/exchanges/index.js'
import type { CardRepository } from '../repository.js'
import type { CoinListingInput } from '../types.js'
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

export const EXCHANGE_LISTING_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETRY_INTERVAL_MS = 60 * 60 * 1000

export interface ExchangeListingSyncResult {
  syncedExchanges: string[]
  failedExchanges: string[]
  listingCount: number
}

interface ExchangeListingSyncServiceOptions {
  repository: CardRepository
  exchangeClients: readonly ExchangeListingProvider[]
  intervalMs?: number
  retryIntervalMs?: number
  now?: () => Date
  logger?: Logger
}

/**
 * Refreshes, once a day, which venues list each tracked coin by reading the public
 * instrument catalog of every configured exchange. One request per market per exchange
 * covers the whole card catalog, so the run costs well under a dozen HTTP calls.
 */
export class ExchangeListingSyncService {
  private readonly repository: CardRepository
  private readonly exchangeClients: readonly ExchangeListingProvider[]
  private readonly intervalMs: number
  private readonly retryIntervalMs: number
  private readonly now: () => Date
  private readonly logger: Logger
  private timer: NodeJS.Timeout | null = null
  private started = false
  private inProgress = false

  constructor(options: ExchangeListingSyncServiceOptions) {
    this.repository = options.repository
    this.exchangeClients = options.exchangeClients
    this.intervalMs = options.intervalMs ?? EXCHANGE_LISTING_SYNC_INTERVAL_MS
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? noopLogger
  }

  start(): void {
    if (this.started) {
      return
    }

    this.started = true
    this.schedule(this.getInitialDelayMs())
  }

  stop(): void {
    this.started = false

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async syncNow(): Promise<ExchangeListingSyncResult | null> {
    if (this.inProgress) {
      return null
    }

    this.inProgress = true

    try {
      const symbolIndex = this.buildTrackedSymbolIndex()

      if (symbolIndex.size === 0) {
        this.logger.warn({}, 'Exchange listing synchronization skipped: no tracked symbols.')
        return null
      }

      const updatedAt = this.now().toISOString()
      const syncedExchanges: string[] = []
      const failedExchanges: string[] = []
      let listingCount = 0

      for (const client of this.exchangeClients) {
        try {
          const listings = this.matchListingsToCards(
            await client.getUsdtListings(),
            symbolIndex
          )

          if (listings.length === 0) {
            // Treated as a failure: a healthy venue always overlaps the MEXC catalog.
            failedExchanges.push(client.id)
            this.logger.warn(
              { exchange: client.id },
              'Exchange listing synchronization returned no matching listings; previous data kept.'
            )
            continue
          }

          listingCount += this.repository.replaceExchangeListings(
            client.id,
            client.label,
            listings,
            updatedAt
          )
          syncedExchanges.push(client.id)
        } catch (error) {
          failedExchanges.push(client.id)
          this.logger.error(
            { err: error, exchange: client.id },
            'Exchange listing synchronization failed for one exchange.'
          )
        }
      }

      if (syncedExchanges.length === 0) {
        this.logger.error({ failedExchanges }, 'Exchange listing synchronization failed for every exchange.')
        return null
      }

      this.repository.setExchangeListingSyncCompletedAt(updatedAt)
      this.logger.info(
        { syncedExchanges, failedExchanges, listingCount, completedAt: updatedAt },
        'Exchange listing synchronization completed.'
      )

      return { syncedExchanges, failedExchanges, listingCount }
    } catch (error) {
      this.logger.error({ err: error }, 'Exchange listing synchronization failed.')
      return null
    } finally {
      this.inProgress = false
    }
  }

  /**
   * Maps every tracked card symbol and its unscaled alias to the card symbols it can stand for.
   * Both `BONK` and `1000BONK` may be tracked, so one candidate can resolve to several cards.
   */
  private buildTrackedSymbolIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>()

    for (const symbol of this.repository.getTrackedSymbols()) {
      for (const candidate of buildSymbolCandidates(symbol)) {
        const existing = index.get(candidate)

        if (existing === undefined) {
          index.set(candidate, [symbol])
        } else if (!existing.includes(symbol)) {
          existing.push(symbol)
        }
      }
    }

    return index
  }

  private matchListingsToCards(
    listings: readonly { baseSymbol: string; marketType: 'spot' | 'futures'; pair: string; tradeUrl: string | null }[],
    symbolIndex: Map<string, string[]>
  ): CoinListingInput[] {
    const matched = new Map<string, CoinListingInput>()

    for (const listing of listings) {
      for (const candidate of buildSymbolCandidates(listing.baseSymbol)) {
        for (const cardSymbol of symbolIndex.get(candidate) ?? []) {
          const key = `${cardSymbol} ${listing.marketType}`

          // An exact ticker match always beats one reached through a scale alias.
          if (matched.has(key) && candidate !== cardSymbol) {
            continue
          }

          matched.set(key, {
            symbol: cardSymbol,
            marketType: listing.marketType,
            pair: listing.pair,
            tradeUrl: listing.tradeUrl
          })
        }
      }
    }

    return [...matched.values()]
  }

  private getInitialDelayMs(): number {
    const completedAt = this.repository.getExchangeListingSyncCompletedAt()
    const completedAtMs = completedAt === null ? Number.NaN : Date.parse(completedAt)

    if (!Number.isFinite(completedAtMs)) {
      return 0
    }

    return Math.max(0, completedAtMs + this.intervalMs - this.now().getTime())
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
