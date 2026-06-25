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
      mexcAvgDailyVolume3m: 321
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
      mexcAvgDailyVolume3m: 321
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
})
