import { ExchangeHttpClient, readArrayPayload, readString } from './http.js'
import type { ExchangeClientOptions, ExchangeListing, ExchangeListingProvider } from './types.js'

const DEFAULT_BASE_URL = 'https://api.bitget.com'

export class BitgetClient implements ExchangeListingProvider {
  readonly id = 'bitget'
  readonly label = 'Bitget'

  private readonly http: ExchangeHttpClient
  private readonly baseUrl: string

  constructor(options: ExchangeClientOptions = {}) {
    this.http = new ExchangeHttpClient(this.id, options)
    this.baseUrl = options.spotBaseUrl ?? DEFAULT_BASE_URL
  }

  async getUsdtListings(): Promise<ExchangeListing[]> {
    const [spot, futures] = await Promise.all([this.getSpotListings(), this.getFuturesListings()])

    return [...spot, ...futures]
  }

  private async getSpotListings(): Promise<ExchangeListing[]> {
    const payload = await this.http.getJson(
      `${this.baseUrl}/api/v2/spot/public/symbols`,
      'Failed to parse the Bitget spot symbols response.'
    )
    const items = readArrayPayload(
      this.http,
      payload,
      'data',
      'Unexpected Bitget spot symbols payload shape.'
    )

    return items.flatMap((item) => {
      // Bitget echoes the issuer's casing for baseCoin (e.g. "rPBR"), so normalize it.
      const base = readString(item, 'baseCoin').toUpperCase()
      const quote = readString(item, 'quoteCoin').toUpperCase()
      const pair = readString(item, 'symbol').toUpperCase()

      if (!base || quote !== 'USDT' || !pair || readString(item, 'status') !== 'online') {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType: 'spot' as const,
          pair,
          tradeUrl: `https://www.bitget.com/spot/${pair}`
        }
      ]
    })
  }

  private async getFuturesListings(): Promise<ExchangeListing[]> {
    const payload = await this.http.getJson(
      `${this.baseUrl}/api/v2/mix/market/contracts?productType=USDT-FUTURES`,
      'Failed to parse the Bitget USDT futures contracts response.'
    )
    const items = readArrayPayload(
      this.http,
      payload,
      'data',
      'Unexpected Bitget USDT futures contracts payload shape.'
    )

    return items.flatMap((item) => {
      const base = readString(item, 'baseCoin').toUpperCase()
      const quote = readString(item, 'quoteCoin').toUpperCase()
      const pair = readString(item, 'symbol').toUpperCase()

      if (!base || quote !== 'USDT' || !pair || readString(item, 'symbolStatus') !== 'normal') {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType: 'futures' as const,
          pair,
          tradeUrl: `https://www.bitget.com/futures/usdt/${pair}`
        }
      ]
    })
  }
}
