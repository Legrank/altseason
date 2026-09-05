import assert from 'node:assert/strict'
import test from 'node:test'

import { CoingeckoClientError } from '../integrations/coingecko/index.js'
import type { CoingeckoCoin, CoingeckoTicker } from '../integrations/coingecko/index.js'
import { CardRepository } from '../repository.js'
import { CoingeckoListingSyncService } from './coingecko-listing-sync-service.js'

const silentLogger = { info() {}, warn() {}, error() {} }

function ticker(overrides: Partial<CoingeckoTicker> & { exchangeId: string }): CoingeckoTicker {
  return {
    exchangeName: overrides.exchangeId,
    base: 'BTC',
    target: 'USDT',
    tradeUrl: null,
    volumeUsd: 1000,
    trustScore: 'green',
    isStale: false,
    ...overrides
  }
}

interface StubOptions {
  coinsList?: CoingeckoCoin[]
  topCoins?: CoingeckoCoin[]
  tickersByCoinId?: Record<string, CoingeckoTicker[]>
  onGetCoinTickers?: (coinId: string) => void
}

function stubClient(options: StubOptions) {
  const requestedCoinIds: string[] = []

  return {
    requestedCoinIds,
    async getCoinsList() {
      return options.coinsList ?? []
    },
    async getTopCoinsByMarketCap() {
      return options.topCoins ?? []
    },
    async getCoinTickers(coinId: string) {
      requestedCoinIds.push(coinId)
      options.onGetCoinTickers?.(coinId)

      return options.tickersByCoinId?.[coinId] ?? []
    }
  }
}

function seedCards(repository: CardRepository, symbols: string[]): void {
  for (const symbol of symbols) {
    repository.create({ symbol, buyPriceSafe: null, buyPriceRisk: null, sellPrice: null })
  }
}

test('stores aggregator listings for a symbol that resolves to exactly one coin', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  const service = new CoingeckoListingSyncService({
    repository,
    coingeckoClient: stubClient({
      coinsList: [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' }],
      tickersByCoinId: {
        bitcoin: [
          ticker({ exchangeId: 'upbit', exchangeName: 'Upbit', volumeUsd: 500 }),
          ticker({ exchangeId: 'kraken', exchangeName: 'Kraken', volumeUsd: 900 })
        ]
      }
    }),
    now: () => new Date('2026-09-05T10:00:00.000Z')
  })

  const result = await service.syncNow()

  assert.deepEqual(result, { processedSymbols: 1, resolvedSymbols: 1, listingCount: 2 })
  assert.deepEqual(
    repository.listCoinListings().map((listing) => [listing.exchange, listing.source]),
    [
      ['kraken', 'coingecko'],
      ['upbit', 'coingecko']
    ]
  )
})

test('keeps only the deepest market when a venue lists several quotes', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  await new CoingeckoListingSyncService({
    repository,
    coingeckoClient: stubClient({
      coinsList: [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' }],
      tickersByCoinId: {
        bitcoin: [
          ticker({ exchangeId: 'kraken', target: 'EUR', volumeUsd: 100 }),
          ticker({ exchangeId: 'kraken', target: 'USDT', volumeUsd: 900 })
        ]
      }
    }),
    now: () => new Date('2026-09-05T10:00:00.000Z')
  }).syncNow()

  assert.deepEqual(
    repository.listCoinListings().map((listing) => listing.pair),
    ['BTC/USDT']
  )
})

test('skips stale tickers', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['BTC'])
  t.after(() => repository.close())

  await new CoingeckoListingSyncService({
    repository,
    coingeckoClient: stubClient({
      coinsList: [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' }],
      tickersByCoinId: {
        bitcoin: [ticker({ exchangeId: 'dead-exchange', isStale: true })]
      }
    }),
    now: () => new Date('2026-09-05T10:00:00.000Z')
  }).syncNow()

  assert.equal(repository.listCoinListings().length, 0)
})

test('settles an ambiguous ticker by market-cap rank rather than guessing', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['SOL'])
  t.after(() => repository.close())

  const client = stubClient({
    coinsList: [
      { id: 'wrapped-solana', symbol: 'SOL', name: 'Wrapped Solana' },
      { id: 'solana', symbol: 'SOL', name: 'Solana' }
    ],
    topCoins: [
      { id: 'solana', symbol: 'SOL', name: 'Solana' },
      { id: 'wrapped-solana', symbol: 'SOL', name: 'Wrapped Solana' }
    ],
    tickersByCoinId: { solana: [ticker({ exchangeId: 'kraken', base: 'SOL' })] }
  })

  await new CoingeckoListingSyncService({
    repository,
    coingeckoClient: client,
    now: () => new Date('2026-09-05T10:00:00.000Z')
  }).syncNow()

  assert.deepEqual(client.requestedCoinIds, ['solana'])
})

test('leaves an ambiguous unranked ticker unresolved instead of attributing another coin', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['CAT'])
  t.after(() => repository.close())

  const client = stubClient({
    coinsList: [
      { id: 'cat-one', symbol: 'CAT', name: 'Cat One' },
      { id: 'cat-two', symbol: 'CAT', name: 'Cat Two' }
    ],
    topCoins: []
  })

  const result = await new CoingeckoListingSyncService({
    repository,
    coingeckoClient: client,
    now: () => new Date('2026-09-05T10:00:00.000Z')
  }).syncNow()

  assert.deepEqual(client.requestedCoinIds, [])
  assert.deepEqual(result, { processedSymbols: 1, resolvedSymbols: 0, listingCount: 0 })
  assert.equal(repository.listCoinListings().length, 0)
})

test('spends the budget on the oldest cards and rotates on the next run', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['AAA', 'BBB', 'CCC'])
  t.after(() => repository.close())

  const coins = ['AAA', 'BBB', 'CCC'].map((symbol) => ({
    id: symbol.toLowerCase(),
    symbol,
    name: symbol
  }))
  const client = stubClient({ coinsList: coins })
  let currentTime = Date.parse('2026-09-05T10:00:00.000Z')
  const service = new CoingeckoListingSyncService({
    repository,
    coingeckoClient: client,
    dailyCoinBudget: 2,
    now: () => new Date(currentTime)
  })

  await service.syncNow()
  assert.deepEqual(client.requestedCoinIds, ['aaa', 'bbb'])

  currentTime += 60 * 60 * 1000
  await service.syncNow()

  // The never-synced card leads the queue, then the rotation wraps to the oldest refresh.
  assert.deepEqual(client.requestedCoinIds, ['aaa', 'bbb', 'ccc', 'aaa'])
})

test('stops the run on a rate limit and leaves the rest of the budget for later', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['AAA', 'BBB', 'CCC'])
  t.after(() => repository.close())

  const client = stubClient({
    coinsList: ['AAA', 'BBB', 'CCC'].map((symbol) => ({
      id: symbol.toLowerCase(),
      symbol,
      name: symbol
    })),
    onGetCoinTickers(coinId) {
      if (coinId === 'bbb') {
        throw new CoingeckoClientError('rate_limit', 'rate limited', { retryAfterMs: 60_000 })
      }
    }
  })

  const result = await new CoingeckoListingSyncService({
    repository,
    coingeckoClient: client,
    dailyCoinBudget: 3,
    now: () => new Date('2026-09-05T10:00:00.000Z'),
    logger: silentLogger
  }).syncNow()

  assert.deepEqual(client.requestedCoinIds, ['aaa', 'bbb'])
  assert.deepEqual(result, { processedSymbols: 1, resolvedSymbols: 1, listingCount: 0 })
})

test('resolves a scaled MEXC symbol through its unscaled ticker', async (t) => {
  const repository = new CardRepository(':memory:')
  seedCards(repository, ['1000BONK'])
  t.after(() => repository.close())

  const client = stubClient({
    coinsList: [{ id: 'bonk', symbol: 'BONK', name: 'Bonk' }],
    tickersByCoinId: { bonk: [ticker({ exchangeId: 'kraken', base: 'BONK' })] }
  })

  await new CoingeckoListingSyncService({
    repository,
    coingeckoClient: client,
    now: () => new Date('2026-09-05T10:00:00.000Z')
  }).syncNow()

  assert.deepEqual(client.requestedCoinIds, ['bonk'])
  assert.deepEqual(
    repository.listCoinListings().map((listing) => listing.symbol),
    ['1000BONK']
  )
})
