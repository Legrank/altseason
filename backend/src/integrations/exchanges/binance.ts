import { ExchangeHttpClient, readArrayPayload, readString } from './http.js'
import type { ExchangeClientOptions, ExchangeListing, ExchangeListingProvider } from './types.js'

const DEFAULT_SPOT_BASE_URL = 'https://api.binance.com'
const DEFAULT_FUTURES_BASE_URL = 'https://fapi.binance.com'

export class BinanceClient implements ExchangeListingProvider {
  readonly id = 'binance'
  readonly label = 'Binance'

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
      `${this.spotBaseUrl}/api/v3/exchangeInfo?permissions=SPOT`,
      'Failed to parse the Binance spot exchangeInfo response.'
    )
    const items = readArrayPayload(
      this.http,
      payload,
      'symbols',
      'Unexpected Binance spot exchangeInfo payload shape.'
    )

    return items.flatMap((item) => {
      const base = readString(item, 'baseAsset').toUpperCase()
      const quote = readString(item, 'quoteAsset').toUpperCase()
      const pair = readString(item, 'symbol').toUpperCase()

      if (!base || quote !== 'USDT' || !pair || readString(item, 'status') !== 'TRADING') {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType: 'spot' as const,
          pair,
          tradeUrl: `https://www.binance.com/en/trade/${base}_${quote}`
        }
      ]
    })
  }

  private async getFuturesListings(): Promise<ExchangeListing[]> {
    const payload = await this.http.getJson(
      `${this.futuresBaseUrl}/fapi/v1/exchangeInfo`,
      'Failed to parse the Binance futures exchangeInfo response.'
    )
    const items = readArrayPayload(
      this.http,
      payload,
      'symbols',
      'Unexpected Binance futures exchangeInfo payload shape.'
    )

    return items.flatMap((item) => {
      const base = readString(item, 'baseAsset').toUpperCase()
      const quote = readString(item, 'quoteAsset').toUpperCase()
      const pair = readString(item, 'symbol').toUpperCase()

      if (
        !base ||
        quote !== 'USDT' ||
        !pair ||
        readString(item, 'status') !== 'TRADING' ||
        readString(item, 'contractType') !== 'PERPETUAL'
      ) {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType: 'futures' as const,
          pair,
          tradeUrl: `https://www.binance.com/en/futures/${pair}`
        }
      ]
    })
  }
}
