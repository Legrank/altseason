import { CardRepository } from '../repository.js'
import type {
  Card,
  CardExchange,
  CardPayload,
  ExchangeMarketType,
  StoredCard,
  StoredCoinListing
} from '../types.js'
import { calculateRobustAverage } from './robust-average.js'

interface DailyVolumeProvider {
  getUsdtFuturesDailyAmounts(symbol: string, limit?: number): Promise<number[]>
}

interface CardServiceOptions {
  repository: CardRepository
  dailyVolumeProvider?: DailyVolumeProvider
}

const DAILY_VOLUME_LOOKBACK_DAYS = 90
const MARKET_TYPE_ORDER: ExchangeMarketType[] = ['spot', 'futures']

export class CardService {
  private readonly repository: CardRepository
  private readonly dailyVolumeProvider?: DailyVolumeProvider

  constructor(options: CardServiceOptions) {
    this.repository = options.repository
    this.dailyVolumeProvider = options.dailyVolumeProvider
  }

  list(): Card[] {
    const exchangesBySymbol = new Map<string, StoredCoinListing[]>()

    for (const listing of this.repository.listCoinListings()) {
      const existing = exchangesBySymbol.get(listing.symbol)

      if (existing === undefined) {
        exchangesBySymbol.set(listing.symbol, [listing])
      } else {
        existing.push(listing)
      }
    }

    return this.repository
      .list()
      .map((card) => this.toCard(card, exchangesBySymbol.get(card.symbol) ?? []))
  }

  async create(payload: CardPayload): Promise<Card> {
    const mexcDailyAmounts3m = await this.fetchDailyAmounts(payload.symbol)
    const card = this.repository.create(payload, { mexcDailyAmounts3m })

    return this.toCard(card, this.repository.listCoinListingsForSymbol(card.symbol))
  }

  async update(id: number, payload: CardPayload): Promise<Card | null> {
    const existing = this.repository.getById(id)

    if (!existing) {
      return null
    }

    const mexcDailyAmounts3m =
      existing.symbol === payload.symbol
        ? existing.mexcDailyAmounts3m
        : await this.fetchDailyAmounts(payload.symbol)

    const updated = this.repository.update(id, payload, { mexcDailyAmounts3m })

    return updated
      ? this.toCard(updated, this.repository.listCoinListingsForSymbol(updated.symbol))
      : null
  }

  private async fetchDailyAmounts(symbol: string): Promise<number[] | null> {
    if (!this.dailyVolumeProvider) {
      return null
    }

    try {
      return await this.dailyVolumeProvider.getUsdtFuturesDailyAmounts(
        `${symbol}_USDT`,
        DAILY_VOLUME_LOOKBACK_DAYS
      )
    } catch {
      return null
    }
  }

  /**
   * Collapses the per-market listing rows of one card into one entry per venue.
   * A venue read directly from its own API outranks the same venue reported by the
   * aggregator, which only ever contributes exchanges no direct client covers.
   */
  private toCardExchanges(listings: readonly StoredCoinListing[]): CardExchange[] {
    const rowsByExchange = new Map<string, StoredCoinListing[]>()

    for (const listing of listings) {
      const existing = rowsByExchange.get(listing.exchange)

      if (existing === undefined) {
        rowsByExchange.set(listing.exchange, [listing])
      } else {
        existing.push(listing)
      }
    }

    const exchanges: CardExchange[] = []

    for (const [exchange, rows] of rowsByExchange) {
      const direct = rows.filter((row) => row.source === 'exchange')
      const chosen = direct.length > 0 ? direct : rows
      const marketTypes = [...new Set(chosen.map((row) => row.marketType))].sort(
        (left, right) => MARKET_TYPE_ORDER.indexOf(left) - MARKET_TYPE_ORDER.indexOf(right)
      )
      // "Where else can I buy this" is a spot question, so a spot link wins the badge.
      const linked =
        chosen.find((row) => row.marketType === 'spot' && row.tradeUrl !== null) ??
        chosen.find((row) => row.tradeUrl !== null)

      exchanges.push({
        exchange,
        label: chosen[0].label,
        marketTypes,
        source: chosen[0].source,
        tradeUrl: linked?.tradeUrl ?? null
      })
    }

    return exchanges.sort((left, right) => {
      if (left.source !== right.source) {
        return left.source === 'exchange' ? -1 : 1
      }

      return left.label.localeCompare(right.label)
    })
  }

  private toCard(card: StoredCard, listings: readonly StoredCoinListing[]): Card {
    return {
      id: card.id,
      symbol: card.symbol,
      buyPriceSafe: card.buyPriceSafe,
      buyPriceRisk: card.buyPriceRisk,
      sellPrice: card.sellPrice,
      buyPriceSafeMaxIncreasePercent: this.calculateMaxIncreasePercent(
        card.buyPriceSafe,
        card.buyPriceSafeMaxObserved
      ),
      buyPriceRiskMaxIncreasePercent: this.calculateMaxIncreasePercent(
        card.buyPriceRisk,
        card.buyPriceRiskMaxObserved
      ),
      sellPriceMaxDecreasePercent: this.calculateMaxDecreasePercent(
        card.sellPrice,
        card.sellPriceMinObserved
      ),
      youtubeUrl: card.youtubeUrl,
      telegramPostUrl: card.telegramPostUrl,
      createdAt: card.createdAt,
      mexcPrice: card.mexcPrice,
      mexcAvgDailyVolume3m: calculateRobustAverage(card.mexcDailyAmounts3m ?? []),
      mexcVolume24h: card.mexcAmount24h,
      mexcPriceUpdatedAt: card.mexcPriceUpdatedAt,
      mexcSyncStatus: card.mexcSyncStatus,
      exchanges: this.toCardExchanges(listings)
    }
  }

  private calculateMaxIncreasePercent(level: number | null, maximum: number | null): number | null {
    if (level === null || maximum === null || level <= 0) {
      return null
    }

    return Math.max(0, ((maximum - level) / level) * 100)
  }

  private calculateMaxDecreasePercent(level: number | null, minimum: number | null): number | null {
    if (level === null || minimum === null || level <= 0) {
      return null
    }

    return Math.max(0, ((level - minimum) / level) * 100)
  }
}
