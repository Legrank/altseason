import assert from 'node:assert/strict'
import test from 'node:test'

import { CardRepository } from '../repository.js'
import {
  MEXC_CONTRACT_SYNC_INTERVAL_MS,
  MexcContractSyncService
} from './mexc-contract-sync-service.js'

test('creates new USDT listings and removes delisted cards', async (t) => {
  const repository = new CardRepository(':memory:')
  const btc = repository.create({
    symbol: 'BTC',
    buyPriceSafe: 60000,
    buyPriceRisk: null,
    sellPrice: 80000
  })
  repository.create({ symbol: 'OLD', buyPriceSafe: null, buyPriceRisk: null, sellPrice: null })

  t.after(() => repository.close())

  const service = new MexcContractSyncService({
    repository,
    mexcClient: {
      async getUsdtFuturesContractSymbols() {
        return ['ETH_USDT', 'BTC_USDT', 'ETH_USDT', 'BTC_USD']
      }
    },
    now: () => new Date('2026-08-21T10:00:00.000Z')
  })

  const result = await service.syncNow()
  const cards = repository.list()

  assert.deepEqual(result, { createdCount: 1, deletedCount: 1 })
  assert.deepEqual(
    cards.map((card) => card.symbol).sort(),
    ['BTC', 'ETH']
  )
  assert.equal(repository.getById(btc.id)?.buyPriceSafe, 60000)
  assert.equal(repository.getById(btc.id)?.sellPrice, 80000)
  assert.equal(repository.getUsdtContractSyncCompletedAt(), '2026-08-21T10:00:00.000Z')
})

test('does not delete cards or record success for an empty contract response', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.create({ symbol: 'BTC', buyPriceSafe: null, buyPriceRisk: null, sellPrice: null })

  t.after(() => repository.close())

  const service = new MexcContractSyncService({
    repository,
    mexcClient: {
      async getUsdtFuturesContractSymbols() {
        return []
      }
    },
    now: () => new Date('2026-08-21T10:00:00.000Z')
  })

  const result = await service.syncNow()

  assert.equal(result, null)
  assert.deepEqual(repository.getTrackedSymbols(), ['BTC'])
  assert.equal(repository.getUsdtContractSyncCompletedAt(), null)
})

test('runs immediately without prior sync metadata', async (t) => {
  const repository = new CardRepository(':memory:')
  let resolveCall!: () => void
  const called = new Promise<void>((resolve) => {
    resolveCall = resolve
  })
  let calls = 0
  const service = new MexcContractSyncService({
    repository,
    mexcClient: {
      async getUsdtFuturesContractSymbols() {
        calls += 1
        resolveCall()
        return ['BTC_USDT']
      }
    },
    now: () => new Date('2026-08-21T10:00:00.000Z')
  })

  t.after(() => {
    service.stop()
    repository.close()
  })

  service.start()
  await called

  assert.equal(calls, 1)
})

test('does not resync on restart before the persisted weekly interval elapses', async (t) => {
  const repository = new CardRepository(':memory:')
  repository.syncUsdtContractCards(['BTC'], '2026-08-20T10:00:00.000Z')
  let calls = 0
  const service = new MexcContractSyncService({
    repository,
    mexcClient: {
      async getUsdtFuturesContractSymbols() {
        calls += 1
        return ['BTC_USDT']
      }
    },
    now: () => new Date('2026-08-21T10:00:00.000Z')
  })

  t.after(() => {
    service.stop()
    repository.close()
  })

  service.start()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(calls, 0)
  assert.equal(MEXC_CONTRACT_SYNC_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000)
})
