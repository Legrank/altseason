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
  exchanges: CardExchange[]
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
  buyPriceSafeMaxObserved: number | null
  buyPriceRiskMaxObserved: number | null
  sellPriceMinObserved: number | null
  youtubeUrl: string | null
  telegramPostUrl: string | null
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
  youtubeUrl?: string | null
  telegramPostUrl?: string | null
}

export type ExchangeMarketType = 'spot' | 'futures'

export type CoinListingSource = 'exchange' | 'coingecko'

export interface CardExchange {
  exchange: string
  label: string
  marketTypes: ExchangeMarketType[]
  source: CoinListingSource
  tradeUrl: string | null
}

export interface StoredCoinListing {
  symbol: string
  exchange: string
  label: string
  marketType: ExchangeMarketType
  pair: string
  source: CoinListingSource
  tradeUrl: string | null
  volumeUsd24h: number | null
  updatedAt: string
}

export interface CoinListingInput {
  symbol: string
  marketType: ExchangeMarketType
  pair: string
  tradeUrl: string | null
  volumeUsd24h?: number | null
}

export interface CoingeckoListingInput {
  exchange: string
  label: string
  marketType: ExchangeMarketType
  pair: string
  tradeUrl: string | null
  volumeUsd24h: number | null
}
