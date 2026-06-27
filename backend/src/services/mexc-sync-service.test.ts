import assert from 'node:assert/strict'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import { CardRepository } from '../repository.js'
import { MexcSyncService } from './mexc-sync-service.js'

test('syncs all tracked symbols from one snapshot', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create({ symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null })
  repository.create({ symbol: 'ETH', buyPriceSafe: 200, buyPriceRisk: null, sellPrice: null })

  t.after(() => {
    repository.close()
  })

  let calls = 0
  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        calls += 1
        return new Map([
          ['BTC_USDT', { lastPrice: 62000.1, amount24: 1100 }],
          ['ETH_USDT', { lastPrice: 3400.2, amount24: 2200 }]
        ])
      }
    },
    now: () => new Date('2026-06-23T12:00:00.000Z')
  })

  await service.syncNow()

  const cards = repository.list()

  assert.equal(calls, 1)
  assert.equal(cards.find((card) => card.symbol === 'BTC')?.mexcPrice, 62000.1)
  assert.equal(cards.find((card) => card.symbol === 'ETH')?.mexcPrice, 3400.2)
  assert.equal(cards.every((card) => card.mexcSyncStatus === 'synced'), true)
})

test('marks symbols as not found when snapshot lacks their USDT pair', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create({ symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null })
  repository.create({ symbol: 'ABC', buyPriceSafe: 200, buyPriceRisk: null, sellPrice: null })

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 1100 }]])
      }
    },
    now: () => new Date('2026-06-23T12:00:00.000Z')
  })

  await service.syncNow()

  const cards = repository.list()
  const btc = cards.find((card) => card.symbol === 'BTC')
  const abc = cards.find((card) => card.symbol === 'ABC')

  assert.equal(btc?.mexcSyncStatus, 'synced')
  assert.equal(abc?.mexcSyncStatus, 'not_found')
  assert.equal(abc?.mexcPrice, null)
  assert.equal(abc?.mexcPriceUpdatedAt, null)
})

test('does not wipe last successful price when sync fails', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create({ symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null })
  repository.applyMexcPrice('BTC', 62000.1, '2026-06-23T11:00:00.000Z')
  repository.create({ symbol: 'NEW', buyPriceSafe: 200, buyPriceRisk: null, sellPrice: null })

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        throw new Error('network down')
      }
    }
  })

  await service.syncNow()

  const cards = repository.list()
  const btc = cards.find((card) => card.symbol === 'BTC')
  const fresh = cards.find((card) => card.symbol === 'NEW')

  assert.equal(btc?.mexcPrice, 62000.1)
  assert.equal(btc?.mexcPriceUpdatedAt, '2026-06-23T11:00:00.000Z')
  assert.equal(btc?.mexcSyncStatus, 'synced')
  assert.equal(fresh?.mexcPrice, null)
  assert.equal(fresh?.mexcSyncStatus, 'error')
})

test('rolls daily amounts once per UTC day using amount24 from ticker', async (t) => {
  const repository = new CardRepository(':memory:')
  const created = repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcDailyAmounts3m: [300, 200, 100] }
  )

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 999 }]])
      }
    },
    now: () => new Date('2026-06-24T00:05:00.000Z')
  })

  await service.syncNow()

  const updated = repository.getById(created.id)

  assert.deepEqual(updated?.mexcDailyAmounts3m, [999, 300, 200, 100])
  assert.equal(updated?.mexcDailyAmountsUtcDate, '2026-06-24')
})

test('does not roll daily amounts more than once on the same UTC day', async (t) => {
  const repository = new CardRepository(':memory:')
  const created = repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcDailyAmounts3m: [300, 200, 100], mexcDailyAmountsUtcDate: '2026-06-24' }
  )

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 999 }]])
      }
    },
    now: () => new Date('2026-06-24T12:05:00.000Z')
  })

  await service.syncNow()

  const updated = repository.getById(created.id)

  assert.deepEqual(updated?.mexcDailyAmounts3m, [300, 200, 100])
  assert.equal(updated?.mexcDailyAmountsUtcDate, '2026-06-24')
})

test('syncs 1000 cards in one batch without degrading sharply', async (t) => {
  const databasePath = join(tmpdir(), `altseason-sync-batch-${Date.now()}.sqlite`)
  const repository = new CardRepository(databasePath)
  const snapshot = new Map<string, { lastPrice: number; amount24: number | null }>()
  const cardCount = 1000

  for (let index = 0; index < cardCount; index += 1) {
    const symbol = `COIN${String(index).padStart(4, '0')}`
    repository.create({
      symbol,
      buyPriceSafe: index + 100,
      buyPriceRisk: null,
      sellPrice: null
    })
    snapshot.set(`${symbol}_USDT`, {
      lastPrice: index + 1000.5,
      amount24: index + 5000
    })
  }

  t.after(() => {
    repository.close()

    for (const path of [`${databasePath}-shm`, `${databasePath}-wal`, databasePath]) {
      if (existsSync(path)) {
        unlinkSync(path)
      }
    }
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return snapshot
      }
    },
    now: () => new Date('2026-06-27T12:00:00.000Z')
  })

  const startedAt = performance.now()
  await service.syncNow()
  const durationMs = performance.now() - startedAt
  const cards = repository.list()

  t.diagnostic(`1000-card sync completed in ${durationMs.toFixed(2)}ms`)

  assert.equal(cards.length, cardCount)
  assert.equal(cards.every((card) => card.mexcSyncStatus === 'synced'), true)
  assert.equal(cards.every((card) => card.mexcPrice !== null), true)
  assert.ok(durationMs < 3000)
})
