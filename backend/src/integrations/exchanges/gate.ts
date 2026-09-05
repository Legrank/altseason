import { ExchangeHttpClient, readArrayPayload, readString } from './http.js'
import type { ExchangeClientOptions, ExchangeListing, ExchangeListingProvider } from './types.js'

const DEFAULT_BASE_URL = 'https://api.gateio.ws'

export class GateClient implements ExchangeListingProvider {
  readonly id = 'gate'
  readonly label = 'Gate'

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
      `${this.baseUrl}/api/v4/spot/currency_pairs`,
      'Failed to parse the Gate spot currency_pairs response.'
    )
    const items = readArrayPayload(
      this.http,
      payload,
      null,
      'Unexpected Gate spot currency_pairs payload shape.'
    )

    return items.flatMap((item) => {
      const base = readString(item, 'base').toUpperCase()
      const quote = readString(item, 'quote').toUpperCase()
      const pair = readString(item, 'id').toUpperCase()

      if (!base || quote !== 'USDT' || !pair || readString(item, 'trade_status') !== 'tradable') {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType: 'spot' as const,
          pair,
          tradeUrl: `https://www.gate.io/trade/${pair}`
        }
      ]
    })
  }

  private async getFuturesListings(): Promise<ExchangeListing[]> {
    const payload = await this.http.getJson(
      `${this.baseUrl}/api/v4/futures/usdt/contracts`,
      'Failed to parse the Gate USDT futures contracts response.'
    )
    const items = readArrayPayload(
      this.http,
      payload,
      null,
      'Unexpected Gate USDT futures contracts payload shape.'
    )

    return items.flatMap((item) => {
      const pair = readString(item, 'name').toUpperCase()
      const base = pair.endsWith('_USDT') ? pair.slice(0, -'_USDT'.length) : ''

      if (!base || Reflect.get(item as object, 'in_delisting') === true) {
        return []
      }

      return [
        {
          baseSymbol: base,
          marketType: 'futures' as const,
          pair,
          tradeUrl: `https://www.gate.io/futures/USDT/${pair}`
        }
      ]
    })
  }
}
