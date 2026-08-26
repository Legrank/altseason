import assert from 'node:assert/strict'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
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
  assert.equal(cards.find((card) => card.symbol === 'BTC')?.mexcAmount24h, 1100)
  assert.equal(cards.find((card) => card.symbol === 'ETH')?.mexcPrice, 3400.2)
  assert.equal(cards.find((card) => card.symbol === 'ETH')?.mexcAmount24h, 2200)
  assert.equal(cards.every((card) => card.mexcSyncStatus === 'synced'), true)
})

test('creates one event when ratio crosses a threshold upward', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcAmount24h: 190, mexcDailyAmounts3m: [100, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 220 }]])
      }
    },
    now: () => new Date('2026-06-29T12:00:00.000Z')
  })

  await service.syncNow()

  assert.deepEqual(repository.listRatioThresholdEvents(2), [
    {
      id: 1,
      symbol: 'BTC',
      threshold: 2,
      eventAt: '2026-06-29T12:00:00.000Z',
      crossedThresholdCount: 1
    }
  ])
  assert.deepEqual(repository.listRatioThresholdEvents(3), [])
})

test('creates price-level events when price crosses buy levels upward and sell level downward', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create({
    symbol: 'BTC',
    buyPriceSafe: 110,
    buyPriceRisk: 120,
    sellPrice: 90
  })
  repository.applyMexcPrice('BTC', 100, '2026-06-29T11:55:00.000Z', { utcDate: '2026-06-29' })

  t.after(() => {
    repository.close()
  })

  let lastPrice = 125
  let now = new Date('2026-06-29T12:00:00.000Z')
  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice, amount24: 500 }]])
      }
    },
    now: () => now
  })

  await service.syncNow()

  lastPrice = 85
  now = new Date('2026-06-29T12:05:00.000Z')
  await service.syncNow()

  assert.deepEqual(repository.listPriceLevelEventsSince(0), [
    {
      id: 1,
      cardId: 1,
      symbol: 'BTC',
      kind: 'buyPriceSafe',
      direction: 'up',
      triggerPrice: 110,
      marketPrice: 125,
      eventAt: '2026-06-29T12:00:00.000Z'
    },
    {
      id: 2,
      cardId: 1,
      symbol: 'BTC',
      kind: 'buyPriceRisk',
      direction: 'up',
      triggerPrice: 120,
      marketPrice: 125,
      eventAt: '2026-06-29T12:00:00.000Z'
    },
    {
      id: 3,
      cardId: 1,
      symbol: 'BTC',
      kind: 'sellPrice',
      direction: 'down',
      triggerPrice: 90,
      marketPrice: 85,
      eventAt: '2026-06-29T12:05:00.000Z'
    }
  ])
})

test('does not create duplicate price-level events for the same card and level on the same UTC day', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create({
    symbol: 'BTC',
    buyPriceSafe: 110,
    buyPriceRisk: null,
    sellPrice: null
  })
  repository.applyMexcPrice('BTC', 100, '2026-06-29T11:55:00.000Z', { utcDate: '2026-06-29' })

  t.after(() => {
    repository.close()
  })

  let lastPrice = 115
  let now = new Date('2026-06-29T12:00:00.000Z')
  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice, amount24: 500 }]])
      }
    },
    now: () => now
  })

  await service.syncNow()
  lastPrice = 100
  now = new Date('2026-06-29T12:05:00.000Z')
  await service.syncNow()
  lastPrice = 111
  now = new Date('2026-06-29T12:10:00.000Z')
  await service.syncNow()

  assert.deepEqual(repository.listPriceLevelEventsSince(0), [
    {
      id: 1,
      cardId: 1,
      symbol: 'BTC',
      kind: 'buyPriceSafe',
      direction: 'up',
      triggerPrice: 110,
      marketPrice: 115,
      eventAt: '2026-06-29T12:00:00.000Z'
    }
  ])
})

test('creates a repeated price-level event on a later UTC day after recrossing the same level', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create({
    symbol: 'BTC',
    buyPriceSafe: null,
    buyPriceRisk: null,
    sellPrice: 90
  })
  repository.applyMexcPrice('BTC', 95, '2026-06-29T11:55:00.000Z', { utcDate: '2026-06-29' })

  t.after(() => {
    repository.close()
  })

  let lastPrice = 85
  let now = new Date('2026-06-29T12:00:00.000Z')
  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice, amount24: 500 }]])
      }
    },
    now: () => now
  })

  await service.syncNow()
  lastPrice = 95
  now = new Date('2026-06-30T00:05:00.000Z')
  await service.syncNow()
  lastPrice = 88
  now = new Date('2026-06-30T12:00:00.000Z')
  await service.syncNow()

  assert.deepEqual(repository.listPriceLevelEventsSince(0), [
    {
      id: 1,
      cardId: 1,
      symbol: 'BTC',
      kind: 'sellPrice',
      direction: 'down',
      triggerPrice: 90,
      marketPrice: 85,
      eventAt: '2026-06-29T12:00:00.000Z'
    },
    {
      id: 2,
      cardId: 1,
      symbol: 'BTC',
      kind: 'sellPrice',
      direction: 'down',
      triggerPrice: 90,
      marketPrice: 88,
      eventAt: '2026-06-30T12:00:00.000Z'
    }
  ])
})

test('tracks a buy signal statistic, avoids open duplicates, and freezes it after a 10% drop', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create({
    symbol: 'BTC',
    buyPriceSafe: 110,
    buyPriceRisk: null,
    sellPrice: null
  })
  repository.applyMexcPrice('BTC', 100, '2026-06-29T11:55:00.000Z', { utcDate: '2026-06-29' })

  t.after(() => {
    repository.close()
  })

  repository.applyMexcPrice('BTC', 115, '2026-06-29T12:00:00.000Z', { utcDate: '2026-06-29' })
  repository.applyMexcPrice('BTC', 130, '2026-06-29T12:05:00.000Z', { utcDate: '2026-06-29' })
  repository.applyMexcPrice('BTC', 105, '2026-06-30T11:55:00.000Z', { utcDate: '2026-06-30' })
  repository.applyMexcPrice('BTC', 111, '2026-06-30T12:00:00.000Z', { utcDate: '2026-06-30' })

  let statistics = repository.listPriceSignalStatistics()

  assert.equal(statistics.length, 1)
  assert.deepEqual(statistics[0], {
    id: 1,
    symbol: 'BTC',
    kind: 'buyPriceSafe',
    direction: 'up',
    levelPrice: 110,
    signalPrice: 115,
    extremePrice: 130,
    extremeChangePercent: ((130 - 115) / 115) * 100,
    openedAt: '2026-06-29T12:00:00.000Z',
    closedAt: null,
    closePrice: null,
    status: 'open'
  })

  repository.applyMexcPrice('BTC', 103.5, '2026-06-30T12:05:00.000Z', { utcDate: '2026-06-30' })
  repository.applyMexcPrice('BTC', 140, '2026-06-30T12:10:00.000Z', { utcDate: '2026-06-30' })
  statistics = repository.listPriceSignalStatistics()

  assert.equal(statistics.length, 1)
  assert.equal(statistics[0]?.status, 'closed')
  assert.equal(statistics[0]?.closedAt, '2026-06-30T12:05:00.000Z')
  assert.equal(statistics[0]?.closePrice, 103.5)
  assert.equal(statistics[0]?.extremePrice, 130)

  repository.applyMexcPrice('BTC', 100, '2026-07-01T11:55:00.000Z', { utcDate: '2026-07-01' })
  repository.applyMexcPrice('BTC', 111, '2026-07-01T12:00:00.000Z', { utcDate: '2026-07-01' })
  statistics = repository.listPriceSignalStatistics()

  assert.equal(statistics.length, 2)
  assert.equal(statistics[0]?.status, 'open')
  assert.equal(statistics[0]?.signalPrice, 111)
  assert.equal(statistics[1]?.extremePrice, 130)
})

test('tracks a sell signal minimum and closes it after a 10% rise', () => {
  const repository = new CardRepository(':memory:')
  repository.create({
    symbol: 'ETH',
    buyPriceSafe: null,
    buyPriceRisk: null,
    sellPrice: 100
  })
  repository.applyMexcPrice('ETH', 105, '2026-07-01T10:00:00.000Z', { utcDate: '2026-07-01' })

  repository.applyMexcPrice('ETH', 95, '2026-07-01T10:05:00.000Z', { utcDate: '2026-07-01' })
  repository.applyMexcPrice('ETH', 80, '2026-07-01T10:10:00.000Z', { utcDate: '2026-07-01' })
  repository.applyMexcPrice('ETH', 104.5, '2026-07-01T10:15:00.000Z', { utcDate: '2026-07-01' })

  const [statistic] = repository.listPriceSignalStatistics()

  assert.equal(statistic?.status, 'closed')
  assert.equal(statistic?.signalPrice, 95)
  assert.equal(statistic?.extremePrice, 80)
  assert.equal(statistic?.extremeChangePercent, ((80 - 95) / 95) * 100)
  assert.equal(statistic?.closedAt, '2026-07-01T10:15:00.000Z')
  assert.equal(statistic?.closePrice, 104.5)

  repository.applyMexcPrice('ETH', 70, '2026-07-01T10:20:00.000Z', { utcDate: '2026-07-01' })

  assert.equal(repository.listPriceSignalStatistics()[0]?.extremePrice, 80)
  repository.close()
})

test('does not create an event when amount24 is less than twice the latest completed daily volume', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcAmount24h: 190, mexcDailyAmounts3m: [150, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 260 }]])
      }
    },
    now: () => new Date('2026-06-29T12:00:00.000Z')
  })

  await service.syncNow()

  assert.deepEqual(repository.listRatioThresholdEvents(2), [])
})

test('does not create an event when ratio stays above the threshold', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcAmount24h: 230, mexcDailyAmounts3m: [100, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 260 }]])
      }
    },
    now: () => new Date('2026-06-29T12:00:00.000Z')
  })

  await service.syncNow()

  assert.deepEqual(repository.listRatioThresholdEvents(2), [])
})

test('does not create a second event for the same symbol and threshold on the same UTC day', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcAmount24h: 180, mexcDailyAmounts3m: [100, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )

  t.after(() => {
    repository.close()
  })

  let amount24 = 240
  let now = new Date('2026-06-29T12:00:00.000Z')
  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24 }]])
      }
    },
    now: () => now
  })

  await service.syncNow()
  amount24 = 150
  now = new Date('2026-06-29T12:05:00.000Z')
  await service.syncNow()
  amount24 = 230
  now = new Date('2026-06-29T12:10:00.000Z')
  await service.syncNow()

  assert.deepEqual(repository.listRatioThresholdEvents(2), [
    {
      id: 1,
      symbol: 'BTC',
      threshold: 2,
      eventAt: '2026-06-29T12:00:00.000Z',
      crossedThresholdCount: 1
    }
  ])
})

test('creates another event on a later UTC day after ratio drops back below a threshold and crosses it again', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcAmount24h: 180, mexcDailyAmounts3m: [100, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )

  t.after(() => {
    repository.close()
  })

  let amount24 = 240
  let now = new Date('2026-06-29T12:00:00.000Z')
  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24 }]])
      }
    },
    now: () => now
  })

  await service.syncNow()
  amount24 = 150
  now = new Date('2026-06-29T12:05:00.000Z')
  await service.syncNow()
  amount24 = 180
  now = new Date('2026-06-30T00:05:00.000Z')
  await service.syncNow()
  amount24 = 420
  now = new Date('2026-06-30T12:00:00.000Z')
  await service.syncNow()

  assert.deepEqual(repository.listRatioThresholdEvents(2), [
    {
      id: 2,
      symbol: 'BTC',
      threshold: 2,
      eventAt: '2026-06-30T12:00:00.000Z',
      crossedThresholdCount: 3
    },
    {
      id: 1,
      symbol: 'BTC',
      threshold: 2,
      eventAt: '2026-06-29T12:00:00.000Z',
      crossedThresholdCount: 1
    }
  ])
})

test('creates one event per crossed threshold and marks large jumps', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcAmount24h: 180, mexcDailyAmounts3m: [100, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 420 }]])
      }
    },
    now: () => new Date('2026-06-29T12:00:00.000Z')
  })

  await service.syncNow()

  for (const threshold of [2, 3, 4] as const) {
    assert.deepEqual(repository.listRatioThresholdEvents(threshold), [
      {
        id: threshold - 1,
        symbol: 'BTC',
        threshold,
        eventAt: '2026-06-29T12:00:00.000Z',
        crossedThresholdCount: 3
      }
    ])
  }

  assert.deepEqual(repository.listRatioThresholdEvents(5), [])
})

test('does not create events when there is no previous ratio yet', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcDailyAmounts3m: [100, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 220 }]])
      }
    },
    now: () => new Date('2026-06-29T12:00:00.000Z')
  })

  await service.syncNow()

  assert.deepEqual(repository.listRatioThresholdEvents(2), [])
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
  assert.equal(btc?.mexcAmount24h, 1100)
  assert.equal(abc?.mexcSyncStatus, 'not_found')
  assert.equal(abc?.mexcAmount24h, null)
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

  const loggedErrors: Array<{ context: Record<string, unknown>; message: string }> = []
  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        throw new Error('network down')
      }
    },
    logger: {
      info() {},
      warn() {},
      error(context, message) {
        loggedErrors.push({ context, message })
      }
    }
  })

  await service.syncNow()

  const cards = repository.list()
  const btc = cards.find((card) => card.symbol === 'BTC')
  const fresh = cards.find((card) => card.symbol === 'NEW')

  assert.equal(btc?.mexcPrice, 62000.1)
  assert.equal(btc?.mexcAmount24h, null)
  assert.equal(btc?.mexcPriceUpdatedAt, '2026-06-23T11:00:00.000Z')
  assert.equal(btc?.mexcSyncStatus, 'synced')
  assert.equal(fresh?.mexcPrice, null)
  assert.equal(fresh?.mexcAmount24h, null)
  assert.equal(fresh?.mexcSyncStatus, 'error')
  assert.equal(loggedErrors[0]?.message, 'MEXC price synchronization failed.')
  assert.equal((loggedErrors[0]?.context.err as Error | undefined)?.message, 'network down')
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

test('deletes ratio threshold events older than 30 days during sync', async (t) => {
  const databasePath = join(tmpdir(), `altseason-ratio-events-retention-${Date.now()}.sqlite`)
  const seededRepository = new CardRepository(databasePath)

  seededRepository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcAmount24h: 150, mexcDailyAmounts3m: [100, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )
  seededRepository.close()

  const seededDatabase = new DatabaseSync(databasePath)
  seededDatabase
    .prepare(`
      INSERT INTO ratio_threshold_events (symbol, threshold, event_at, crossed_threshold_count)
      VALUES (?, ?, ?, ?)
    `)
    .run('BTC', 2, '2026-05-20T12:00:00.000Z', 1)
  seededDatabase.close()

  const repository = new CardRepository(databasePath)

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
        return new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 160 }]])
      }
    },
    now: () => new Date('2026-06-29T12:00:00.000Z')
  })

  await service.syncNow()

  assert.deepEqual(repository.listRatioThresholdEvents(2), [])
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
