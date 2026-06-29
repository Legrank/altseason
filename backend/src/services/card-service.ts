import { CardRepository } from '../repository.js'
import type { Card, CardPayload, StoredCard } from '../types.js'
import { calculateRobustAverage } from './robust-average.js'

interface DailyVolumeProvider {
  getUsdtFuturesDailyAmounts(symbol: string, limit?: number): Promise<number[]>
}

interface CardServiceOptions {
  repository: CardRepository
  dailyVolumeProvider?: DailyVolumeProvider
}

const DAILY_VOLUME_LOOKBACK_DAYS = 90

export class CardService {
  private readonly repository: CardRepository
  private readonly dailyVolumeProvider?: DailyVolumeProvider

  constructor(options: CardServiceOptions) {
    this.repository = options.repository
    this.dailyVolumeProvider = options.dailyVolumeProvider
  }

  list(): Card[] {
    return this.repository.list().map((card) => this.toCard(card))
  }

  async create(payload: CardPayload): Promise<Card> {
    const mexcDailyAmounts3m = await this.fetchDailyAmounts(payload.symbol)
    const card = this.repository.create(payload, { mexcDailyAmounts3m })

    return this.toCard(card)
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

    return updated ? this.toCard(updated) : null
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

  private toCard(card: StoredCard): Card {
    return {
      id: card.id,
      symbol: card.symbol,
      buyPriceSafe: card.buyPriceSafe,
      buyPriceRisk: card.buyPriceRisk,
      sellPrice: card.sellPrice,
      createdAt: card.createdAt,
      mexcPrice: card.mexcPrice,
      mexcAvgDailyVolume3m: calculateRobustAverage(card.mexcDailyAmounts3m ?? []),
      mexcVolume24h: card.mexcAmount24h,
      mexcPriceUpdatedAt: card.mexcPriceUpdatedAt,
      mexcSyncStatus: card.mexcSyncStatus
    }
  }
}
