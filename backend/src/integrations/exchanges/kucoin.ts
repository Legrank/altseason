import { ExchangeHttpClient, readArrayPayload, readString } from './http.js'
import type { ExchangeClientOptions, ExchangeListing, ExchangeListingProvider } from './types.js'

const DEFAULT_SPOT_BASE_URL = 'https://api.kucoin.com'
const DEFAULT_FUTURES_BASE_URL = 'https://api-futures.kucoin.com'

/** KuCoin futures use the legacy XBT ticker for bitcoin. */
const FUTURES_BASE_SYMBOL_ALIASES = new Map([['XBT', 'BTC']])

export class KucoinClient implements ExchangeListingProvider {
  readonly id = 'kucoin'
  readonly label = 'KuCoin'

  private readonly http: ExchangeHttpClient
  private readonly spotBaseUrl: string
  private readonly futuresBaseUrl: string

  constructor(options: ExchangeClientOptions = {}) {
    this.http = new ExchangeHttpClient(this.id, options)
    this.spotBaseUrl = options.spotBaseUrl ?? DEFAULT_SPOT_BASE_URL
    this.futuresBaseUrl = options.futuresBaseUrl ?? DEFAULT_FUTURES_BASE_URL
  }

  async getUsdtListings(): Promise<ExchangeListing[]> {
    const [spot, futures] = await Promise.all([this.getSpotListings(), this.getFuturesListings()])

    return [...spot, ...futures]
  }

  private async getSpotListings(): Promise<ExchangeListing[]> {
    const payload = await this.http.getJson(
      `${this.spotBaseUrl}/api/v2/symbols`,
      'Failed to parse the KuCoin spot symbols response.'
    )
    const items = readArrayPayload(
      this.http,
      payload,
      'data',
      'Unexpected KuCoin spot symbols payload shape.'
    )

    return items.flatMap((item) => {
      const base = readString(item, 'baseCurrency').toUpperCase()
      const quote = readString(item, 'quoteCurrency').toUpperCase()
      const pair = readString(item, 'symbol').toUpperCase()

      if (!base || quote !== 'USDT' || !pair) {
        return []
      }

      if (Reflect.get(item as object, 'enableTrading') === false) {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType: 'spot' as const,
          pair,
          tradeUrl: `https://www.kucoin.com/trade/${pair}`
        }
      ]
    })
  }

  private async getFuturesListings(): Promise<ExchangeListing[]> {
    const payload = await this.http.getJson(
      `${this.futuresBaseUrl}/api/v1/contracts/active`,
      'Failed to parse the KuCoin futures contracts response.'
    )
    const items = readArrayPayload(
      this.http,
      payload,
      'data',
      'Unexpected KuCoin futures contracts payload shape.'
    )

    return items.flatMap((item) => {
      const rawBase = readString(item, 'baseCurrency').toUpperCase()
      const quote = readString(item, 'quoteCurrency').toUpperCase()
      const pair = readString(item, 'symbol').toUpperCase()

      if (!rawBase || quote !== 'USDT' || !pair || readString(item, 'status') !== 'Open') {
        return []
      }

      if (Reflect.get(item as object, 'isInverse') === true) {
        return []
      }

      return [
        {
          baseSymbol: FUTURES_BASE_SYMBOL_ALIASES.get(rawBase) ?? rawBase,
          marketType: 'futures' as const,
          pair,
          tradeUrl: `https://www.kucoin.com/futures/trade/${pair}`
        }
      ]
    })
  }
}
