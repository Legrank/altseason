import assert from 'node:assert/strict'
import test from 'node:test'

import { CardRepository } from '../repository.js'
import { MexcSyncService } from './mexc-sync-service.js'

test('syncs all tracked symbols from one snapshot', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create({ symbol: 'BTC', price: 100 })
  repository.create({ symbol: 'ETH', price: 200 })

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
          ['BTC_USDT', 62000.1],
          ['ETH_USDT', 3400.2]
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
  repository.create({ symbol: 'BTC', price: 100 })
  repository.create({ symbol: 'ABC', price: 200 })

  t.after(() => {
    repository.close()
  })

  const service = new MexcSyncService({
    repository,
    mexcClient: {
      async getAllUsdtFuturesPrices() {
        return new Map([['BTC_USDT', 62000.1]])
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
  repository.create({ symbol: 'BTC', price: 100 })
  repository.applyMexcPrice('BTC', 62000.1, '2026-06-23T11:00:00.000Z')
  repository.create({ symbol: 'NEW', price: 200 })

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
