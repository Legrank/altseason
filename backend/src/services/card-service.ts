import { CardRepository } from '../repository.js'
import type { Card, CardPayload } from '../types.js'
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
    return this.repository.list()
  }

  async create(payload: CardPayload): Promise<Card> {
    const mexcAvgDailyVolume3m = await this.calculateAvgDailyVolume(payload.symbol)

    return this.repository.create(payload, { mexcAvgDailyVolume3m })
  }

  async update(id: number, payload: CardPayload): Promise<Card | null> {
    const existing = this.repository.getById(id)

    if (!existing) {
      return null
    }

    const mexcAvgDailyVolume3m =
      existing.symbol === payload.symbol
        ? existing.mexcAvgDailyVolume3m
        : await this.calculateAvgDailyVolume(payload.symbol)

    return this.repository.update(id, payload, { mexcAvgDailyVolume3m })
  }

  private async calculateAvgDailyVolume(symbol: string): Promise<number | null> {
    if (!this.dailyVolumeProvider) {
      return null
    }

    try {
      const amounts = await this.dailyVolumeProvider.getUsdtFuturesDailyAmounts(
        `${symbol}_USDT`,
        DAILY_VOLUME_LOOKBACK_DAYS
      )

      return calculateRobustAverage(amounts)
    } catch {
      return null
    }
  }
}
