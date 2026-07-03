export type MexcSyncStatus = 'pending' | 'synced' | 'not_found' | 'error'

export interface Card {
  id: number
  symbol: string
  buyPriceSafe: number | null
  buyPriceRisk: number | null
  sellPrice: number | null
  createdAt: string
  mexcPrice: number | null
  mexcAvgDailyVolume3m: number | null
  mexcVolume24h: number | null
  mexcPriceUpdatedAt: string | null
  mexcSyncStatus: MexcSyncStatus
}

export interface RatioThresholdEvent {
  id: number
  symbol: string
  threshold: number
  eventAt: string
  crossedThresholdCount: number
}

export type PriceLevelEventKind = 'buyPriceSafe' | 'buyPriceRisk' | 'sellPrice'

export type PriceLevelEventDirection = 'up' | 'down'

export interface PriceLevelEvent {
  id: number
  cardId: number
  symbol: string
  kind: PriceLevelEventKind
  direction: PriceLevelEventDirection
  triggerPrice: number
  marketPrice: number
  eventAt: string
}

export interface TelegramSubscriber {
  chatId: string
  userId: string
  username: string | null
  firstName: string | null
  minThreshold: number
  isActive: boolean
  createdAt: string
  updatedAt: string
  lastNotifiedEventId: number | null
  lastNotifiedPriceEventId: number | null
}

export interface StoredCard {
  id: number
  symbol: string
  buyPriceSafe: number | null
  buyPriceRisk: number | null
  sellPrice: number | null
  createdAt: string
  mexcPrice: number | null
  mexcAmount24h: number | null
  mexcDailyAmounts3m: number[] | null
  mexcDailyAmountsUtcDate: string | null
  mexcPriceUpdatedAt: string | null
  mexcSyncStatus: MexcSyncStatus
}

export interface CardPayload {
  symbol: string
  buyPriceSafe: number | null
  buyPriceRisk: number | null
  sellPrice: number | null
}
