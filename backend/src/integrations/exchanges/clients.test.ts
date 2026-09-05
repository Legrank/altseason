import assert from 'node:assert/strict'
import test from 'node:test'

import { BinanceClient } from './binance.js'
import { BitgetClient } from './bitget.js'
import { BybitClient } from './bybit.js'
import { GateClient } from './gate.js'
import { ExchangeClientError } from './http.js'
import { KucoinClient } from './kucoin.js'
import { OkxClient } from './okx.js'

function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const match = Object.keys(routes).find((fragment) => url.includes(fragment))

    if (match === undefined) {
      throw new Error(`Unexpected request: ${url}`)
    }

    return new Response(JSON.stringify(routes[match]))
  }) as unknown as typeof fetch
}

test('Binance keeps trading USDT spot pairs and perpetual futures only', async () => {
  const client = new BinanceClient({
    fetchImpl: stubFetch({
      '/api/v3/exchangeInfo': {
        symbols: [
          { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
          { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING' },
          { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', status: 'BREAK' }
        ]
      },
      '/fapi/v1/exchangeInfo': {
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            contractType: 'PERPETUAL'
          },
          {
            symbol: 'BTCUSDT_250926',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            contractType: 'CURRENT_QUARTER'
          }
        ]
      }
    })
  })

  const listings = await client.getUsdtListings()

  assert.deepEqual(
    listings.map((listing) => [listing.baseSymbol, listing.marketType]),
    [
      ['BTC', 'spot'],
      ['BTC', 'futures']
    ]
  )
})

test('Bybit drops dated linear contracts and keeps perpetuals', async () => {
  const client = new BybitClient({
    fetchImpl: stubFetch({
      'category=spot': {
        result: {
          list: [{ symbol: 'SOLUSDT', baseCoin: 'SOL', quoteCoin: 'USDT', status: 'Trading' }]
        }
      },
      'category=linear': {
        result: {
          list: [
            { symbol: 'SOLUSDT', baseCoin: 'SOL', quoteCoin: 'USDT', status: 'Trading' },
            { symbol: 'SOL-26SEP25', baseCoin: 'SOL', quoteCoin: 'USDT', status: 'Trading' }
          ]
        }
      }
    })
  })

  const listings = await client.getUsdtListings()

  assert.deepEqual(
    listings.map((listing) => [listing.baseSymbol, listing.marketType, listing.pair]),
    [
      ['SOL', 'spot', 'SOLUSDT'],
      ['SOL', 'futures', 'SOLUSDT']
    ]
  )
})

test('OKX derives the swap base symbol from the instrument family and skips inverse contracts', async () => {
  const client = new OkxClient({
    fetchImpl: stubFetch({
      'instType=SPOT': {
        data: [{ instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live' }]
      },
      'instType=SWAP': {
        data: [
          {
            instId: 'BTC-USDT-SWAP',
            instFamily: 'BTC-USDT',
            baseCcy: '',
            settleCcy: 'USDT',
            ctType: 'linear',
            state: 'live'
          },
          {
            instId: 'BTC-USD-SWAP',
            instFamily: 'BTC-USD',
            baseCcy: '',
            settleCcy: 'BTC',
            ctType: 'inverse',
            state: 'live'
          }
        ]
      }
    })
  })

  const listings = await client.getUsdtListings()

  assert.deepEqual(
    listings.map((listing) => [listing.baseSymbol, listing.marketType]),
    [
      ['BTC', 'spot'],
      ['BTC', 'futures']
    ]
  )
})

test('Gate skips untradable pairs and delisting contracts', async () => {
  const client = new GateClient({
    fetchImpl: stubFetch({
      '/spot/currency_pairs': [
        { id: 'ALEPH_USDT', base: 'ALEPH', quote: 'USDT', trade_status: 'tradable' },
        { id: 'DEAD_USDT', base: 'DEAD', quote: 'USDT', trade_status: 'untradable' }
      ],
      '/futures/usdt/contracts': [
        { name: 'ALEPH_USDT', in_delisting: false },
        { name: 'GONE_USDT', in_delisting: true }
      ]
    })
  })

  const listings = await client.getUsdtListings()

  assert.deepEqual(
    listings.map((listing) => [listing.baseSymbol, listing.marketType]),
    [
      ['ALEPH', 'spot'],
      ['ALEPH', 'futures']
    ]
  )
})

test('KuCoin maps the legacy XBT futures ticker back to BTC', async () => {
  const client = new KucoinClient({
    fetchImpl: stubFetch({
      '/api/v2/symbols': {
        data: [
          { symbol: 'BTC-USDT', baseCurrency: 'BTC', quoteCurrency: 'USDT', enableTrading: true },
          { symbol: 'OFF-USDT', baseCurrency: 'OFF', quoteCurrency: 'USDT', enableTrading: false }
        ]
      },
      '/api/v1/contracts/active': {
        data: [
          {
            symbol: 'XBTUSDTM',
            baseCurrency: 'XBT',
            quoteCurrency: 'USDT',
            status: 'Open',
            isInverse: false
          }
        ]
      }
    })
  })

  const listings = await client.getUsdtListings()

  assert.deepEqual(
    listings.map((listing) => [listing.baseSymbol, listing.marketType]),
    [
      ['BTC', 'spot'],
      ['BTC', 'futures']
    ]
  )
})

test('Bitget normalizes the issuer casing of base coins', async () => {
  const client = new BitgetClient({
    fetchImpl: stubFetch({
      '/spot/public/symbols': {
        data: [{ symbol: 'RPBRUSDT', baseCoin: 'rPBR', quoteCoin: 'USDT', status: 'online' }]
      },
      '/mix/market/contracts': {
        data: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', symbolStatus: 'normal' }]
      }
    })
  })

  const listings = await client.getUsdtListings()

  assert.deepEqual(
    listings.map((listing) => listing.baseSymbol),
    ['RPBR', 'BTC']
  )
})

test('a rate-limited response starts a cooldown and the next call fails fast', async () => {
  let requestCount = 0
  let currentTime = 0
  const client = new GateClient({
    now: () => currentTime,
    fetchImpl: (async () => {
      requestCount += 1
      return new Response('{}', { status: 429, headers: { 'Retry-After': '30' } })
    }) as unknown as typeof fetch
  })

  await assert.rejects(client.getUsdtListings(), (error: unknown) => {
    assert.ok(error instanceof ExchangeClientError)
    assert.equal(error.code, 'rate_limit')
    assert.equal(error.retryAfterMs, 30_000)
    return true
  })

  const requestCountAfterRateLimit = requestCount
  currentTime = 10_000

  await assert.rejects(client.getUsdtListings(), (error: unknown) => {
    assert.ok(error instanceof ExchangeClientError)
    assert.equal(error.code, 'cooldown')
    return true
  })

  assert.equal(requestCount, requestCountAfterRateLimit)
})

test('an unexpected payload shape is reported as a parse error', async () => {
  const client = new BitgetClient({
    fetchImpl: stubFetch({ '/spot/public/symbols': { data: 'nope' }, '/mix/market/contracts': { data: [] } })
  })

  await assert.rejects(client.getUsdtListings(), (error: unknown) => {
    assert.ok(error instanceof ExchangeClientError)
    assert.equal(error.code, 'parse')
    return true
  })
})
