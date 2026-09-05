import { BinanceClient } from './binance.js'
import { BitgetClient } from './bitget.js'
import { BybitClient } from './bybit.js'
import { GateClient } from './gate.js'
import { KucoinClient } from './kucoin.js'
import { OkxClient } from './okx.js'
import type { ExchangeClientOptions, ExchangeListingProvider } from './types.js'

export { BinanceClient } from './binance.js'
export { BitgetClient } from './bitget.js'
export { BybitClient } from './bybit.js'
export { GateClient } from './gate.js'
export { KucoinClient } from './kucoin.js'
export { OkxClient } from './okx.js'
export { ExchangeClientError } from './http.js'
export type {
  ExchangeClientOptions,
  ExchangeListing,
  ExchangeListingProvider,
  ExchangeMarketType
} from './types.js'

export function createDefaultExchangeClients(
  options: ExchangeClientOptions = {}
): ExchangeListingProvider[] {
  return [
    new BinanceClient(options),
    new BybitClient(options),
    new OkxClient(options),
    new GateClient(options),
    new KucoinClient(options),
    new BitgetClient(options)
  ]
}
