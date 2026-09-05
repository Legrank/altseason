import { ExchangeHttpClient, readArrayPayload, readString } from './http.js'
import type { ExchangeClientOptions, ExchangeListing, ExchangeListingProvider } from './types.js'

const DEFAULT_BASE_URL = 'https://www.okx.com'

export class OkxClient implements ExchangeListingProvider {
  readonly id = 'okx'
  readonly label = 'OKX'

  private readonly http: ExchangeHttpClient
  private readonly baseUrl: string

  constructor(options: ExchangeClientOptions = {}) {
    this.http = new ExchangeHttpClient(this.id, options)
    this.baseUrl = options.spotBaseUrl ?? DEFAULT_BASE_URL
  }

  async getUsdtListings(): Promise<ExchangeListing[]> {
    const [spot, swap] = await Promise.all([this.getSpotListings(), this.getSwapListings()])

    return [...spot, ...swap]
  }

  private async getSpotListings(): Promise<ExchangeListing[]> {
    const items = await this.getInstruments('SPOT')

    return items.flatMap((item) => {
      const base = readString(item, 'baseCcy').toUpperCase()
      const quote = readString(item, 'quoteCcy').toUpperCase()
      const pair = readString(item, 'instId').toUpperCase()

      if (!base || quote !== 'USDT' || !pair || readString(item, 'state') !== 'live') {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType: 'spot' as const,
          pair,
          tradeUrl: `https://www.okx.com/trade-spot/${pair.toLowerCase()}`
        }
      ]
    })
  }

  private async getSwapListings(): Promise<ExchangeListing[]> {
    const items = await this.getInstruments('SWAP')

    return items.flatMap((item) => {
      const pair = readString(item, 'instId').toUpperCase()
      // OKX leaves baseCcy empty on derivatives; the instrument family ("BTC-USDT") carries it.
      const base = readString(item, 'instFamily').toUpperCase().split('-')[0] ?? ''

      if (
        !base ||
        !pair ||
        readString(item, 'settleCcy').toUpperCase() !== 'USDT' ||
        readString(item, 'ctType') !== 'linear' ||
        readString(item, 'state') !== 'live'
      ) {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType: 'futures' as const,
          pair,
          tradeUrl: `https://www.okx.com/trade-swap/${pair.toLowerCase()}`
        }
      ]
    })
  }

  private async getInstruments(instType: 'SPOT' | 'SWAP'): Promise<unknown[]> {
    const payload = await this.http.getJson(
      `${this.baseUrl}/api/v5/public/instruments?instType=${instType}`,
      `Failed to parse the OKX ${instType} instruments response.`
    )

    return readArrayPayload(
      this.http,
      payload,
      'data',
      `Unexpected OKX ${instType} instruments payload shape.`
    )
  }
}
