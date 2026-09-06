import type { CoingeckoPerpetual } from '../integrations/coingecko/index.js'
import type { CardRepository } from '../repository.js'
import type { CoingeckoListingInput } from '../types.js'
import { buildSymbolCandidates, normalizeSymbol } from './symbol-aliases.js'

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
const DEFAULT_MAX_VENUES_PER_COIN = 5

/** The venue every card already lives on; listing it under "also listed on" says nothing. */
const OWN_EXCHANGE_ID = 'mexc'

/**
 * CoinGecko appends the market type to a venue name. Stripping it is what lets
 * "Binance (Futures)" merge into the same badge as the directly-read "binance",
 * instead of rendering as a second, near-duplicate venue.
 *
 * Only these exact market-type suffixes are stripped: a trailing parenthetical is not
 * always a market type ("KiloEx (BSC)", "GMX Perpetuals V2 (Arbitrum)" name a chain),
 * and the leading space keeps a venue such as "SynFutures" intact.
 */
const MARKET_TYPE_SUFFIXES = [
  ' (Futures)',
  ' (Derivatives)',
  ' (Derivative)',
  ' (Perpetual)',
  ' (Perpetuals)',
  ' Futures',
  ' Derivatives'
] as const

export interface ExchangeIdentity {
  id: string
  label: string
}

export function toExchangeIdentity(market: string): ExchangeIdentity | null {
  let label = market.trim()

  for (const suffix of MARKET_TYPE_SUFFIXES) {
    if (label.endsWith(suffix)) {
      label = label.slice(0, -suffix.length).trim()
      break
    }
  }

  const id = label.toLowerCase().replace(/[^a-z0-9]+/gu, '')

  return id ? { id, label } : null
}

export interface CoingeckoListingSyncResult {
  matchedSymbols: number
  listingCount: number
}

interface PerpetualDerivativesProvider {
  getPerpetualDerivatives(): Promise<CoingeckoPerpetual[]>
}

interface CoingeckoListingSyncServiceOptions {
  repository: CardRepository
  coingeckoClient: PerpetualDerivativesProvider
  /** Venues kept per coin, ranked by open interest. */
  maxVenuesPerCoin?: number
  intervalMs?: number
  retryIntervalMs?: number
  now?: () => Date
  logger?: Logger
}

/**
 * Adds the derivatives venues the direct exchange clients do not cover.
 *
 * `GET /derivatives` returns every perpetual on every venue CoinGecko tracks in a single
 * call, and carries the underlying ticker in `index_id`, so this costs one credit a day
 * and needs none of the coin-id resolution a per-coin lookup would.
 *
 * A coin trades on far more venues than a card can usefully show, so only the top
 * `maxVenuesPerCoin` by open interest are kept — counted after dropping MEXC itself and
 * any venue a direct client already reports, so the slots go to genuinely new venues.
 */
export class CoingeckoListingSyncService {
  private readonly repository: CardRepository
  private readonly coingeckoClient: PerpetualDerivativesProvider
  private readonly maxVenuesPerCoin: number
  private readonly intervalMs: number
  private readonly retryIntervalMs: number
  private readonly now: () => Date
  private readonly logger: Logger
  private timer: NodeJS.Timeout | null = null
  private started = false
  private inProgress = false

  constructor(options: CoingeckoListingSyncServiceOptions) {
    this.repository = options.repository
    this.coingeckoClient = options.coingeckoClient
    this.maxVenuesPerCoin = options.maxVenuesPerCoin ?? DEFAULT_MAX_VENUES_PER_COIN
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
    this.schedule(this.getInitialDelayMs())
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
      const trackedSymbols = this.repository.getTrackedSymbols()

      if (trackedSymbols.length === 0) {
        this.logger.warn({}, 'CoinGecko listing synchronization skipped: no tracked symbols.')
        return null
      }

      const perpetuals = await this.coingeckoClient.getPerpetualDerivatives()

      // An empty response must never be allowed to wipe the stored venues.
      if (perpetuals.length === 0) {
        this.logger.error({}, 'CoinGecko returned no perpetual contracts; previous data kept.')
        return null
      }

      const coveredExchangeIds = new Set(this.repository.getDirectlySourcedExchangeIds())
      const listings = this.selectListings(trackedSymbols, perpetuals, coveredExchangeIds)

      // Every tracked coin has at least one perpetual somewhere, so a total miss means the
      // payload changed shape rather than that the venues disappeared.
      if (listings.length === 0) {
        this.logger.error(
          { perpetualCount: perpetuals.length },
          'CoinGecko perpetuals matched no tracked coin; previous data kept.'
        )
        return null
      }

      const updatedAt = this.now().toISOString()
      const listingCount = this.repository.replaceCoingeckoListings(listings, updatedAt)
      const matchedSymbols = new Set(listings.map((listing) => listing.symbol)).size

      this.repository.setCoingeckoListingSyncCompletedAt(updatedAt)
      this.logger.info(
        {
          matchedSymbols,
          listingCount,
          perpetualCount: perpetuals.length,
          maxVenuesPerCoin: this.maxVenuesPerCoin,
          completedAt: updatedAt
        },
        'CoinGecko listing synchronization completed.'
      )

      return { matchedSymbols, listingCount }
    } catch (error) {
      this.logger.error({ err: error }, 'CoinGecko listing synchronization failed.')
      return null
    } finally {
      this.inProgress = false
    }
  }

  private selectListings(
    trackedSymbols: readonly string[],
    perpetuals: readonly CoingeckoPerpetual[],
    coveredExchangeIds: ReadonlySet<string>
  ): CoingeckoListingInput[] {
    const byIndexId = new Map<string, CoingeckoPerpetual[]>()

    for (const perpetual of perpetuals) {
      const existing = byIndexId.get(perpetual.indexId)

      if (existing === undefined) {
        byIndexId.set(perpetual.indexId, [perpetual])
      } else {
        existing.push(perpetual)
      }
    }

    const listings: CoingeckoListingInput[] = []

    for (const symbol of trackedSymbols) {
      const bestByExchange = new Map<
        string,
        { identity: ExchangeIdentity; perpetual: CoingeckoPerpetual }
      >()

      for (const candidate of buildSymbolCandidates(symbol)) {
        for (const perpetual of byIndexId.get(candidate) ?? []) {
          const identity = toExchangeIdentity(perpetual.market)

          if (identity === null || identity.id === OWN_EXCHANGE_ID) {
            continue
          }

          if (coveredExchangeIds.has(identity.id)) {
            continue
          }

          const existing = bestByExchange.get(identity.id)

          // A venue can run several perpetuals on one asset; rank it by its deepest.
          if (existing !== undefined && openInterestOf(existing.perpetual) >= openInterestOf(perpetual)) {
            continue
          }

          bestByExchange.set(identity.id, { identity, perpetual })
        }
      }

      const ranked = [...bestByExchange.values()]
        .sort((left, right) => openInterestOf(right.perpetual) - openInterestOf(left.perpetual))
        .slice(0, this.maxVenuesPerCoin)

      for (const { identity, perpetual } of ranked) {
        listings.push({
          symbol: normalizeSymbol(symbol),
          exchange: identity.id,
          label: identity.label,
          marketType: 'futures',
          pair: perpetual.symbol || perpetual.indexId,
          // /derivatives carries no trade URL, unlike the direct exchange catalogs.
          tradeUrl: null,
          volumeUsd24h: perpetual.volume24h
        })
      }
    }

    return listings
  }

  private getInitialDelayMs(): number {
    const completedAt = this.repository.getCoingeckoListingSyncCompletedAt()
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

/** Contracts without a reported open interest rank below every contract that has one. */
function openInterestOf(perpetual: CoingeckoPerpetual): number {
  return perpetual.openInterest ?? -1
}
