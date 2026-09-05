import assert from 'node:assert/strict'
import test from 'node:test'

import { CardRepository } from '../repository.js'
import { CardService } from './card-service.js'

test('creates a card with computed average daily volume', async (t) => {
  const repository = new CardRepository(':memory:')

  t.after(() => {
    repository.close()
  })

  let requestedSymbol: string | null = null
  let requestedLimit: number | null = null
  const service = new CardService({
    repository,
    dailyVolumeProvider: {
      async getUsdtFuturesDailyAmounts(symbol, limit) {
        requestedSymbol = symbol
        requestedLimit = limit ?? null
        return [100, 110, 120]
      }
    }
  })

  const created = await service.create({
    symbol: 'BTC',
    buyPriceSafe: 100,
    buyPriceRisk: null,
    sellPrice: null
  })

  assert.equal(requestedSymbol, 'BTC_USDT')
  assert.equal(requestedLimit, 90)
  assert.equal(created.mexcAvgDailyVolume3m, 110)
  assert.equal(created.mexcVolume24h, null)
  assert.deepEqual(repository.getById(created.id)?.mexcDailyAmounts3m, [100, 110, 120])
})

test('returns maximum growth and decline percentages since each level was saved', async (t) => {
  const repository = new CardRepository(':memory:')

  t.after(() => {
    repository.close()
  })

  const stored = repository.create({
    symbol: 'BTC',
    buyPriceSafe: 100,
    buyPriceRisk: 80,
    sellPrice: 200
  })
  const service = new CardService({ repository })

  repository.applyMexcSnapshot(
    new Map([['BTC_USDT', { lastPrice: 130, amount24: null }]]),
    '2026-06-23T10:00:00.000Z',
    '2026-06-23'
  )
  repository.applyMexcPrice('BTC', 70, '2026-06-23T10:05:00.000Z')

  const tracked = service.list()[0]

  assert.equal(tracked.buyPriceSafeMaxIncreasePercent, 30)
  assert.equal(tracked.buyPriceRiskMaxIncreasePercent, 62.5)
  assert.equal(tracked.sellPriceMaxDecreasePercent, 65)

  const updated = await service.update(stored.id, {
    symbol: 'BTC',
    buyPriceSafe: 120,
    buyPriceRisk: 80,
    sellPrice: 200
  })

  assert.equal(updated?.buyPriceSafeMaxIncreasePercent, 0)
  assert.equal(updated?.buyPriceRiskMaxIncreasePercent, 62.5)
  assert.equal(updated?.sellPriceMaxDecreasePercent, 65)
})

test('keeps average daily volume when symbol does not change', async (t) => {
  const repository = new CardRepository(':memory:')

  t.after(() => {
    repository.close()
  })

  const existing = repository.create(
    {
      symbol: 'BTC',
      buyPriceSafe: 100,
      buyPriceRisk: null,
      sellPrice: null
    },
    {
      mexcDailyAmounts3m: [321, 321, 321]
    }
  )

  let calls = 0
  const service = new CardService({
    repository,
    dailyVolumeProvider: {
      async getUsdtFuturesDailyAmounts() {
        calls += 1
        return [1, 2, 3]
      }
    }
  })

  const updated = await service.update(existing.id, {
    symbol: 'BTC',
    buyPriceSafe: 150,
    buyPriceRisk: 90,
    sellPrice: 200
  })

  assert.equal(updated?.mexcAvgDailyVolume3m, 321)
  assert.equal(updated?.mexcVolume24h, null)
  assert.deepEqual(repository.getById(existing.id)?.mexcDailyAmounts3m, [321, 321, 321])
  assert.equal(calls, 0)
})

test('recomputes average daily volume when symbol changes', async (t) => {
  const repository = new CardRepository(':memory:')

  t.after(() => {
    repository.close()
  })

  const existing = repository.create(
    {
      symbol: 'BTC',
      buyPriceSafe: 100,
      buyPriceRisk: null,
      sellPrice: null
    },
    {
      mexcDailyAmounts3m: [321, 321, 321]
    }
  )

  const service = new CardService({
    repository,
    dailyVolumeProvider: {
      async getUsdtFuturesDailyAmounts(symbol) {
        assert.equal(symbol, 'ETH_USDT')
        return [200, 220, 240]
      }
    }
  })

  const updated = await service.update(existing.id, {
    symbol: 'ETH',
    buyPriceSafe: 150,
    buyPriceRisk: null,
    sellPrice: null
  })

  assert.equal(updated?.mexcAvgDailyVolume3m, 220)
  assert.equal(updated?.mexcVolume24h, null)
  assert.deepEqual(repository.getById(existing.id)?.mexcDailyAmounts3m, [200, 220, 240])
})

test('groups a card exchange listings into one entry per venue', async (t) => {
  const repository = new CardRepository(':memory:')

  t.after(() => {
    repository.close()
  })

  repository.create({ symbol: 'BTC', buyPriceSafe: null, buyPriceRisk: null, sellPrice: null })
  repository.replaceExchangeListings(
    'gate',
    'Gate',
    [
      { symbol: 'BTC', marketType: 'spot', pair: 'BTC_USDT', tradeUrl: 'https://gate/spot' },
      { symbol: 'BTC', marketType: 'futures', pair: 'BTC_USDT', tradeUrl: 'https://gate/futures' }
    ],
    '2026-09-05T10:00:00.000Z'
  )

  const [card] = new CardService({ repository }).list()

  assert.deepEqual(card?.exchanges, [
    {
      exchange: 'gate',
      label: 'Gate',
      marketTypes: ['spot', 'futures'],
      source: 'exchange',
      tradeUrl: 'https://gate/spot'
    }
  ])
})

test('a venue read directly outranks the same venue reported by the aggregator', async (t) => {
  const repository = new CardRepository(':memory:')

  t.after(() => {
    repository.close()
  })

  repository.create({ symbol: 'BTC', buyPriceSafe: null, buyPriceRisk: null, sellPrice: null })
  repository.replaceExchangeListings(
    'gate',
    'Gate',
    [{ symbol: 'BTC', marketType: 'futures', pair: 'BTC_USDT', tradeUrl: 'https://gate/futures' }],
    '2026-09-05T10:00:00.000Z'
  )
  repository.replaceCoingeckoListings(
    'BTC',
    'bitcoin',
    [
      {
        exchange: 'gate',
        label: 'Gate.io',
        marketType: 'spot',
        pair: 'BTC/USDT',
        tradeUrl: null,
        volumeUsd24h: 10
      },
      {
        exchange: 'kraken',
        label: 'Kraken',
        marketType: 'spot',
        pair: 'BTC/USD',
        tradeUrl: null,
        volumeUsd24h: 20
      }
    ],
    '2026-09-05T10:00:00.000Z'
  )

  const [card] = new CardService({ repository }).list()

  assert.deepEqual(card?.exchanges, [
    {
      exchange: 'gate',
      label: 'Gate',
      marketTypes: ['futures'],
      source: 'exchange',
      tradeUrl: 'https://gate/futures'
    },
    {
      exchange: 'kraken',
      label: 'Kraken',
      marketTypes: ['spot'],
      source: 'coingecko',
      tradeUrl: null
    }
  ])
})

test('reports an empty exchange list for a coin that trades nowhere else', async (t) => {
  const repository = new CardRepository(':memory:')

  t.after(() => {
    repository.close()
  })

  repository.create({ symbol: 'ARKK', buyPriceSafe: null, buyPriceRisk: null, sellPrice: null })

  const [card] = new CardService({ repository }).list()

  assert.deepEqual(card?.exchanges, [])
})
