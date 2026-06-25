export type MexcSyncStatus = 'pending' | 'synced' | 'not_found' | 'error'

export interface Card {
  id: number
  symbol: string
  buyPriceSafe: number
  buyPriceRisk: number | null
  sellPrice: number | null
  createdAt: string
  mexcPrice: number | null
  mexcAvgDailyVolume3m: number | null
  mexcPriceUpdatedAt: string | null
  mexcSyncStatus: MexcSyncStatus
}

export interface StoredCard {
  id: number
  symbol: string
  buyPriceSafe: number
  buyPriceRisk: number | null
  sellPrice: number | null
  createdAt: string
  mexcPrice: number | null
  mexcDailyAmounts3m: number[] | null
  mexcPriceUpdatedAt: string | null
  mexcSyncStatus: MexcSyncStatus
}

export interface CardPayload {
  symbol: string
  buyPriceSafe: number
  buyPriceRisk: number | null
  sellPrice: number | null
}
