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
  youtubeUrl: string | null
  telegramPostUrl: string | null
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
export type PriceSignalStatisticStatus = 'open' | 'closed'

export interface PriceSignalStatistic {
  id: number
  symbol: string
  kind: PriceLevelEventKind
  direction: PriceLevelEventDirection
  levelPrice: number
  signalPrice: number
  extremePrice: number
  extremeChangePercent: number
  openedAt: string
  closedAt: string | null
  closePrice: number | null
  status: PriceSignalStatisticStatus
}

export interface CardPayload {
  symbol: string
  buyPriceSafe: number | null
  buyPriceRisk: number | null
  sellPrice: number | null
  youtubeUrl: string | null
  telegramPostUrl: string | null
}
