import assert from 'node:assert/strict'
import test from 'node:test'

import type { CoingeckoPerpetual } from '../integrations/coingecko/index.js'
import { CardRepository } from '../repository.js'
import {
  CoingeckoListingSyncService,
  toExchangeIdentity
} from './coingecko-listing-sync-service.js'

const silentLogger = { info() {}, warn() {}, error() {} }

function perpetual(
  market: string,
  indexId: string,
  openInterest: number | null,
  overrides: Partial<CoingeckoPerpetual> = {}
): CoingeckoPerpetual {
  return {
    market,
    symbol: `${indexId}USDT`,
    indexId,
    openInterest,
    volume24h: 1000,
    ...overrides
  }
}

function stubClient(perpetuals: CoingeckoPerpetual[] | (() => Promise<never>)) {
  return {
    async getPerpetualDerivatives() {
      if (typeof perpetuals === 'function') {
        return perpetuals()
      }

      return perpetuals
    }
  }
}

function seedCards(repository: CardRepository, symbols: string[]): void {
  for (const symbol of symbols) {
    repository.create({ symbol, buyPriceSafe: null, buyPriceRisk: null, sellPrice: null })
  }
}

function service(
  repository: CardRepository,
  perpetuals: CoingeckoPerpetual[] | (() => Promise<never>),
  maxVenuesPerCoin = 5
) {
  return new CoingeckoListingSyncService({
    repository,
    coingeckoClient: stubClient(perpetuals),
    maxVenuesPerCoin,
    now: () => new Date('2026-09-06T10:00:00.000Z'),
    logger: silentLogger
  })
}

test('strips only market-type suffixes from a venue name', () => {
  assert.deepEqual(toExchangeIdentity('Binance (Futures)'), { id: 'binance', label: 'Binance' })
  assert.deepEqual(toExchangeIdentity('Bitget Futures'), { id: 'bitget', label: 'Bitget' })
  assert.deepEqual(toExchangeIdentity('XT.COM (Derivatives)'), { id: 'xtcom', label: 'XT.COM' })
  assert.deepEqual(toExchangeIdentity('BitMEX (Derivative)'), { id: 'bitmex', label: 'BitMEX' })
})

test('keeps a parenthetical that names a chain rather than a market type', () => {
  assert.deepEqual(toExchangeIdentity('KiloEx (BSC)'), { id: 'kiloexbsc', label: 'KiloEx (BSC)' })
  assert.deepEqual(toExchangeIdentity('GMX Perpetuals V2 (Arbitrum)'), {
    id: 'gmxperpetualsv2arbitrum',
    label: 'GMX Perpetuals V2 (Arbitrum)'
  })
})

test('does not strip a suffix that is part of the venue name itself', () => {
  assert.deepEqual(toExchangeIdentity('SynFutures'), { id: 'synfutures', label: 'SynFutures' })
})

test('stores futures listings ranked by open interest, capped per coin', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  const result = await service(
    repository,
    [
      perpetual('Hyperliquid (Futures)', 'BTC', 500),
      perpetual('Deribit', 'BTC', 900),
      perpetual('BingX (Futures)', 'BTC', 100),
      perpetual('Zoomex (Futures)', 'BTC', 50)
    ],
    2
  ).syncNow()

  assert.deepEqual(result, { matchedSymbols: 1, listingCount: 2 })
  assert.deepEqual(
    repository.listCoinListingsForSymbol('BTC').map((listing) => [listing.label, listing.marketType]),
    [
      ['Deribit', 'futures'],
      ['Hyperliquid', 'futures']
    ]
  )
})

test('never lists MEXC itself, since every card already lives there', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  await service(repository, [
    perpetual('MEXC (Futures)', 'BTC', 9000),
    perpetual('Deribit', 'BTC', 10)
  ]).syncNow()

  assert.deepEqual(
    repository.listCoinListingsForSymbol('BTC').map((listing) => listing.exchange),
    ['deribit']
  )
})

test('spends its venue slots on exchanges no direct client already reports', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  repository.replaceExchangeListings(
    'binance',
    'Binance',
    [{ symbol: 'BTC', marketType: 'futures', pair: 'BTCUSDT', tradeUrl: null }],
    '2026-09-05T10:00:00.000Z'
  )

  await service(
    repository,
    [
      // Binance outranks everything on open interest but is already covered directly.
      perpetual('Binance (Futures)', 'BTC', 9_000_000),
      perpetual('Deribit', 'BTC', 500),
      perpetual('Hyperliquid (Futures)', 'BTC', 400)
    ],
    2
  ).syncNow()

  assert.deepEqual(
    repository
      .listCoinListingsForSymbol('BTC')
      .filter((listing) => listing.source === 'coingecko')
      .map((listing) => listing.exchange),
    ['deribit', 'hyperliquid']
  )
})

test('ranks a venue by its deepest contract when it runs several on one asset', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  await service(
    repository,
    [
      perpetual('Deribit', 'BTC', 10, { symbol: 'BTC-PERP-A' }),
      perpetual('Deribit', 'BTC', 800, { symbol: 'BTC-PERP-B' }),
      perpetual('Hyperliquid (Futures)', 'BTC', 400)
    ],
    1
  ).syncNow()

  assert.deepEqual(
    repository.listCoinListingsForSymbol('BTC').map((listing) => [listing.exchange, listing.pair]),
    [['deribit', 'BTC-PERP-B']]
  )
})

test('matches a scaled MEXC contract through its unscaled index', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['1000BONK'])
  t.after(() => repository.close())

  await service(repository, [perpetual('Hyperliquid (Futures)', 'BONK', 500)]).syncNow()

  assert.deepEqual(
    repository.listCoinListings().map((listing) => [listing.symbol, listing.exchange]),
    [['1000BONK', 'hyperliquid']]
  )
})

test('ranks contracts without a reported open interest below those that have one', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  await service(
    repository,
    [perpetual('Deribit', 'BTC', null), perpetual('Hyperliquid (Futures)', 'BTC', 1)],
    1
  ).syncNow()

  assert.deepEqual(
    repository.listCoinListingsForSymbol('BTC').map((listing) => listing.exchange),
    ['hyperliquid']
  )
})

test('an empty derivatives response never wipes the stored venues', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  await service(repository, [perpetual('Deribit', 'BTC', 500)]).syncNow()

  const result = await service(repository, []).syncNow()

  assert.equal(result, null)
  assert.equal(repository.listCoinListings().length, 1)
  assert.equal(repository.getCoingeckoListingSyncCompletedAt(), '2026-09-06T10:00:00.000Z')
})

test('a response that matches no tracked coin never wipes the stored venues', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  await service(repository, [perpetual('Deribit', 'BTC', 500)]).syncNow()

  const result = await service(repository, [perpetual('Deribit', 'UNTRACKED', 500)]).syncNow()

  assert.equal(result, null)
  assert.deepEqual(
    repository.listCoinListings().map((listing) => listing.symbol),
    ['BTC']
  )
})

test('a failed request keeps the previous data and reports no success', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  await service(repository, [perpetual('Deribit', 'BTC', 500)]).syncNow()

  const result = await service(repository, () =>
    Promise.reject(new Error('rate limited'))
  ).syncNow()

  assert.equal(result, null)
  assert.equal(repository.listCoinListings().length, 1)
})
