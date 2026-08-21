export type MexcSyncStatus = 'pending' | 'synced' | 'not_found' | 'error'

export interface Card {
  id: number
  symbol: string
  buyPriceSafe: number | null
  buyPriceRisk: number | null
  sellPrice: number | null
  buyPriceSafeMaxIncreasePercent: number | null
  buyPriceRiskMaxIncreasePercent: number | null
  sellPriceMaxDecreasePercent: number | null
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

export interface CardPayload {
  symbol: string
  buyPriceSafe: number | null
  buyPriceRisk: number | null
  sellPrice: number | null
}
