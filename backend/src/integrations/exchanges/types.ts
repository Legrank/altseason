export type ExchangeMarketType = 'spot' | 'futures'

export interface ExchangeListing {
  baseSymbol: string
  marketType: ExchangeMarketType
  pair: string
  tradeUrl: string | null
}

export interface ExchangeListingProvider {
  readonly id: string
  readonly label: string
  getUsdtListings(): Promise<ExchangeListing[]>
}

export interface ExchangeClientOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  spotBaseUrl?: string
  futuresBaseUrl?: string
}
