import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExchangeListing, ExchangeListingProvider } from '../integrations/exchanges/index.js'
import { CardRepository } from '../repository.js'
import { ExchangeListingSyncService } from './exchange-listing-sync-service.js'

function stubExchange(
  id: string,
  label: string,
  listings: ExchangeListing[] | (() => Promise<never>)
): ExchangeListingProvider {
  return {
    id,
    label,
    async getUsdtListings() {
      if (typeof listings === 'function') {
        return listings()
      }

      return listings
    }
  }
}

function spot(baseSymbol: string, pair = `${baseSymbol}USDT`): ExchangeListing {
  return { baseSymbol, marketType: 'spot', pair, tradeUrl: null }
}

function futures(baseSymbol: string, pair = `${baseSymbol}USDT`): ExchangeListing {
  return { baseSymbol, marketType: 'futures', pair, tradeUrl: null }
}

function seedCards(repository: CardRepository, symbols: string[]): void {
  for (const symbol of symbols) {
    repository.create({ symbol, buyPriceSafe: null, buyPriceRisk: null, sellPrice: null })
  }
}

test('stores spot and futures listings for the cards a venue lists', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC', 'SOL'])
  t.after(() => repository.close())

  const service = new ExchangeListingSyncService({
    repository,
    exchangeClients: [stubExchange('gate', 'Gate', [spot('BTC'), futures('BTC'), spot('SOL')])],
    now: () => new Date('2026-09-05T10:00:00.000Z')
  })

  const result = await service.syncNow()

  assert.deepEqual(result, { syncedExchanges: ['gate'], failedExchanges: [], listingCount: 3 })
  assert.deepEqual(
    repository.listCoinListings().map((listing) => [listing.symbol, listing.marketType]),
    [
      ['BTC', 'futures'],
      ['BTC', 'spot'],
      ['SOL', 'spot']
    ]
  )
  assert.equal(repository.getExchangeListingSyncCompletedAt(), '2026-09-05T10:00:00.000Z')
})

test('matches a scaled MEXC contract to the unscaled ticker a venue lists', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['1000BONK', '1000000MOG'])
  t.after(() => repository.close())

  const service = new ExchangeListingSyncService({
    repository,
    exchangeClients: [stubExchange('gate', 'Gate', [spot('BONK'), spot('MOG')])],
    now: () => new Date('2026-09-05T10:00:00.000Z')
  })

  await service.syncNow()

  assert.deepEqual(
    repository.listCoinListings().map((listing) => listing.symbol).sort(),
    ['1000000MOG', '1000BONK']
  )
})

test('matches a scaled venue contract to an unscaled card', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['PEPE'])
  t.after(() => repository.close())

  const service = new ExchangeListingSyncService({
    repository,
    exchangeClients: [stubExchange('bybit', 'Bybit', [futures('1000PEPE', '1000PEPEUSDT')])],
    now: () => new Date('2026-09-05T10:00:00.000Z')
  })

  await service.syncNow()

  assert.deepEqual(
    repository.listCoinListings().map((listing) => [listing.symbol, listing.pair]),
    [['PEPE', '1000PEPEUSDT']]
  )
})

test('prefers an exact ticker match over one reached through a scale alias', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['1000BONK'])
  t.after(() => repository.close())

  const service = new ExchangeListingSyncService({
    repository,
    // The alias match arrives first; the exact one must still win.
    exchangeClients: [
      stubExchange('gate', 'Gate', [spot('BONK', 'BONK_USDT'), spot('1000BONK', '1000BONK_USDT')])
    ],
    now: () => new Date('2026-09-05T10:00:00.000Z')
  })

  await service.syncNow()

  assert.deepEqual(
    repository.listCoinListings().map((listing) => listing.pair),
    ['1000BONK_USDT']
  )
})

test('keeps the listings of the other venues when one exchange fails', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  const okxListings = [spot('BTC')]
  const succeeding = new ExchangeListingSyncService({
    repository,
    exchangeClients: [stubExchange('okx', 'OKX', okxListings)],
    now: () => new Date('2026-09-05T10:00:00.000Z')
  })
  await succeeding.syncNow()

  const failing = new ExchangeListingSyncService({
    repository,
    exchangeClients: [
      stubExchange('binance', 'Binance', () => Promise.reject(new Error('geo-blocked'))),
      stubExchange('okx', 'OKX', okxListings)
    ],
    now: () => new Date('2026-09-06T10:00:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  })

  const result = await failing.syncNow()

  assert.deepEqual(result, {
    syncedExchanges: ['okx'],
    failedExchanges: ['binance'],
    listingCount: 1
  })
  assert.deepEqual(
    repository.listCoinListings().map((listing) => listing.exchange),
    ['okx']
  )
})

test('an empty venue response never wipes that venue and never records success', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  const client = stubExchange('gate', 'Gate', [spot('BTC')])
  await new ExchangeListingSyncService({
    repository,
    exchangeClients: [client],
    now: () => new Date('2026-09-05T10:00:00.000Z')
  }).syncNow()

  const result = await new ExchangeListingSyncService({
    repository,
    exchangeClients: [stubExchange('gate', 'Gate', [])],
    now: () => new Date('2026-09-06T10:00:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  }).syncNow()

  assert.equal(result, null)
  assert.equal(repository.listCoinListings().length, 1)
  assert.equal(repository.getExchangeListingSyncCompletedAt(), '2026-09-05T10:00:00.000Z')
})

test('ignores venue listings for coins that are not tracked', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  const service = new ExchangeListingSyncService({
    repository,
    exchangeClients: [stubExchange('gate', 'Gate', [spot('BTC'), spot('UNTRACKED')])],
    now: () => new Date('2026-09-05T10:00:00.000Z')
  })

  await service.syncNow()

  assert.deepEqual(
    repository.listCoinListings().map((listing) => listing.symbol),
    ['BTC']
  )
})

test('drops listings for a card the contract sync later removes', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC', 'GONE'])
  t.after(() => repository.close())

  await new ExchangeListingSyncService({
    repository,
    exchangeClients: [stubExchange('gate', 'Gate', [spot('BTC'), spot('GONE')])],
    now: () => new Date('2026-09-05T10:00:00.000Z')
  }).syncNow()

  repository.syncUsdtContractCards(['BTC'], '2026-09-06T10:00:00.000Z')

  assert.deepEqual(
    repository.listCoinListings().map((listing) => listing.symbol),
    ['BTC']
  )
})
