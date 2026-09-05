import { ExchangeHttpClient, readArrayPayload, readString } from './http.js'
import type { ExchangeClientOptions, ExchangeListing, ExchangeListingProvider } from './types.js'

const DEFAULT_BASE_URL = 'https://api.bybit.com'

export class BybitClient implements ExchangeListingProvider {
  readonly id = 'bybit'
  readonly label = 'Bybit'

  private readonly http: ExchangeHttpClient
  private readonly baseUrl: string

  constructor(options: ExchangeClientOptions = {}) {
    this.http = new ExchangeHttpClient(this.id, options)
    this.baseUrl = options.spotBaseUrl ?? DEFAULT_BASE_URL
  }

  async getUsdtListings(): Promise<ExchangeListing[]> {
    const [spot, futures] = await Promise.all([
      this.getCategoryListings('spot'),
      this.getCategoryListings('linear')
    ])

    return [...spot, ...futures]
  }

  private async getCategoryListings(category: 'spot' | 'linear'): Promise<ExchangeListing[]> {
    const payload = await this.http.getJson(
      `${this.baseUrl}/v5/market/instruments-info?category=${category}&limit=1000`,
      `Failed to parse the Bybit ${category} instruments-info response.`
    )
    const result =
      typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'result') : null
    const items = readArrayPayload(
      this.http,
      result,
      'list',
      `Unexpected Bybit ${category} instruments-info payload shape.`
    )
    const marketType = category === 'spot' ? ('spot' as const) : ('futures' as const)

    return items.flatMap((item) => {
      const base = readString(item, 'baseCoin').toUpperCase()
      const quote = readString(item, 'quoteCoin').toUpperCase()
      const pair = readString(item, 'symbol').toUpperCase()

      if (!base || quote !== 'USDT' || !pair || readString(item, 'status') !== 'Trading') {
        return []
      }

      // Bybit returns dated futures in the same "linear" category. Only perpetuals use the
      // plain BASEUSDT symbol; dated contracts append a delivery suffix.
      if (marketType === 'futures' && pair !== `${base}USDT`) {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType,
          pair,
          tradeUrl:
            marketType === 'spot'
              ? `https://www.bybit.com/en/trade/spot/${base}/${quote}`
              : `https://www.bybit.com/trade/usdt/${pair}`
        }
      ]
    })
  }
}
