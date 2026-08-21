import test from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from './app.js'
import { CardRepository } from './repository.js'
import { CardService } from './services/card-service.js'

function createTestContext(
  dailyVolumeProvider?: {
    getUsdtFuturesDailyAmounts(symbol: string, limit?: number): Promise<number[]>
  },
  ratioThresholdEventQueryService?: {
    list(threshold: number): Array<{
      id: number
      symbol: string
      threshold: number
      eventAt: string
      crossedThresholdCount: number
    }>
  }
) {
  const repository = new CardRepository(':memory:')
  const cardService = new CardService({
    repository,
    dailyVolumeProvider
  })
  const app = createApp(repository, cardService, ratioThresholdEventQueryService)

  return {
    app,
    repository,
    cardService
  }
}

test('lists ratio threshold events for the exact threshold', async (t) => {
  const { app, repository } = createTestContext(undefined, {
    list(threshold) {
      assert.equal(threshold, 3)

      return [
        {
          id: 10,
          symbol: 'BTC',
          threshold: 3,
          eventAt: '2026-06-29T12:00:00.000Z',
          crossedThresholdCount: 1
        }
      ]
    }
  })

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const response = await app.inject({
    method: 'GET',
    url: '/api/ratio-threshold-events?threshold=3'
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), [
    {
      id: 10,
      symbol: 'BTC',
      threshold: 3,
      eventAt: '2026-06-29T12:00:00.000Z',
      crossedThresholdCount: 1
    }
  ])
})

test('rejects invalid ratio threshold event query values', async (t) => {
  const { app, repository } = createTestContext()

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const invalidResponses = await Promise.all([
    app.inject({
      method: 'GET',
      url: '/api/ratio-threshold-events'
    }),
    app.inject({
      method: 'GET',
      url: '/api/ratio-threshold-events?threshold=1'
    }),
    app.inject({
      method: 'GET',
      url: '/api/ratio-threshold-events?threshold=3.5'
    })
  ])

  assert.equal(invalidResponses[0].statusCode, 400)
  assert.equal(invalidResponses[1].statusCode, 400)
  assert.equal(invalidResponses[2].statusCode, 400)
})

test('creates a card with computed average daily volume and returns it in the list', async (t) => {
  const { app, repository } = createTestContext({
    async getUsdtFuturesDailyAmounts() {
      return [100, 110, 120]
    }
  })

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/cards',
    payload: {
      symbol: 'btc',
      buyPriceSafe: 102345.67
    }
  })

  assert.equal(createResponse.statusCode, 201)
  const createdCard = createResponse.json()

  assert.equal(createdCard.symbol, 'BTC')
  assert.equal(createdCard.buyPriceSafe, 102345.67)
  assert.equal(createdCard.buyPriceRisk, null)
  assert.equal(createdCard.sellPrice, null)
  assert.match(createdCard.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(createdCard.mexcPrice, null)
  assert.equal(createdCard.mexcAvgDailyVolume3m, 110)
  assert.equal(createdCard.mexcVolume24h, null)
  assert.equal(createdCard.mexcPriceUpdatedAt, null)
  assert.equal(createdCard.mexcSyncStatus, 'pending')

  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/cards'
  })

  assert.equal(listResponse.statusCode, 200)
  assert.deepEqual(listResponse.json(), [createdCard])
})

test('creates a card without buyPriceSafe when only the symbol is provided', async (t) => {
  const { app, repository } = createTestContext()

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const response = await app.inject({
    method: 'POST',
    url: '/api/cards',
    payload: {
      symbol: 'sui'
    }
  })

  assert.equal(response.statusCode, 201)
  assert.equal(response.json().symbol, 'SUI')
  assert.equal(response.json().buyPriceSafe, null)
  assert.equal(response.json().buyPriceRisk, null)
  assert.equal(response.json().sellPrice, null)
  assert.equal(response.json().mexcVolume24h, null)
})

test('updates a card without changing createdAt', async (t) => {
  const { app, repository } = createTestContext()

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const created = await app.inject({
    method: 'POST',
    url: '/api/cards',
    payload: {
      symbol: 'eth',
      buyPriceSafe: 2500
    }
  })

  const card = created.json()
  const updateResponse = await app.inject({
    method: 'PUT',
    url: `/api/cards/${card.id}`,
    payload: {
      symbol: 'sol',
      buyPriceSafe: 180.5,
      buyPriceRisk: 170.25,
      sellPrice: 260
    }
  })

  assert.equal(updateResponse.statusCode, 200)
  assert.deepEqual(updateResponse.json(), {
    ...card,
    symbol: 'SOL',
    buyPriceSafe: 180.5,
    buyPriceRisk: 170.25,
    sellPrice: 260,
    buyPriceSafeMaxIncreasePercent: 0,
    buyPriceRiskMaxIncreasePercent: 0,
    sellPriceMaxDecreasePercent: 0,
    mexcPrice: null,
    mexcVolume24h: null,
    mexcPriceUpdatedAt: null,
    mexcSyncStatus: 'pending'
  })
})

test('deletes a card', async (t) => {
  const { app, repository } = createTestContext()

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const created = await app.inject({
    method: 'POST',
    url: '/api/cards',
    payload: {
      symbol: 'xrp',
      buyPriceSafe: 1.23
    }
  })

  const card = created.json()
  const deleteResponse = await app.inject({
    method: 'DELETE',
    url: `/api/cards/${card.id}`
  })

  assert.equal(deleteResponse.statusCode, 204)

  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/cards'
  })

  assert.deepEqual(listResponse.json(), [])
})

test('rejects invalid payloads', async (t) => {
  const { app, repository } = createTestContext()

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const invalidResponses = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/cards',
      payload: {
        symbol: '',
        buyPriceSafe: 100
      }
    }),
    app.inject({
      method: 'POST',
      url: '/api/cards',
      payload: {
        symbol: 'ADA',
        buyPriceSafe: -1
      }
    }),
    app.inject({
      method: 'POST',
      url: '/api/cards',
      payload: {
        symbol: 'ADA',
        buyPriceSafe: 10,
        buyPriceRisk: -1
      }
    })
  ])

  assert.equal(invalidResponses[0].statusCode, 400)
  assert.equal(invalidResponses[1].statusCode, 400)
  assert.equal(invalidResponses[2].statusCode, 400)
})

test('keeps MEXC fields when only manual price changes', async (t) => {
  const { app, repository } = createTestContext()

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const created = await app.inject({
    method: 'POST',
    url: '/api/cards',
    payload: {
      symbol: 'btc',
      buyPriceSafe: 100,
      buyPriceRisk: 80,
      sellPrice: 140
    }
  })

  repository.applyMexcPrice('BTC', 62000.5, '2026-06-23T10:00:00.000Z')

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/cards/${created.json().id}`,
    payload: {
      symbol: 'btc',
      buyPriceSafe: 200,
      buyPriceRisk: null,
      sellPrice: 280
    }
  })

  assert.equal(updated.statusCode, 200)
  assert.equal(updated.json().buyPriceSafe, 200)
  assert.equal(updated.json().buyPriceRisk, null)
  assert.equal(updated.json().sellPrice, 280)
  assert.equal(updated.json().mexcPrice, 62000.5)
  assert.equal(updated.json().mexcAvgDailyVolume3m, null)
  assert.equal(updated.json().mexcVolume24h, null)
  assert.equal(updated.json().mexcPriceUpdatedAt, '2026-06-23T10:00:00.000Z')
  assert.equal(updated.json().mexcSyncStatus, 'synced')
})

test('creates a card with optional risk and sell prices', async (t) => {
  const { app, repository } = createTestContext()

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const response = await app.inject({
    method: 'POST',
    url: '/api/cards',
    payload: {
      symbol: 'ada',
      buyPriceSafe: 0.55,
      buyPriceRisk: 0.48,
      sellPrice: 0.91
    }
  })

  assert.equal(response.statusCode, 201)
  assert.equal(response.json().buyPriceSafe, 0.55)
  assert.equal(response.json().buyPriceRisk, 0.48)
  assert.equal(response.json().sellPrice, 0.91)
  assert.equal(response.json().mexcVolume24h, null)
})

test('creates a card even when average daily volume lookup fails', async (t) => {
  const { app, repository } = createTestContext({
    async getUsdtFuturesDailyAmounts() {
      throw new Error('network down')
    }
  })

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const response = await app.inject({
    method: 'POST',
    url: '/api/cards',
    payload: {
      symbol: 'bnb',
      buyPriceSafe: 650
    }
  })

  assert.equal(response.statusCode, 201)
  assert.equal(response.json().mexcAvgDailyVolume3m, null)
  assert.equal(response.json().mexcVolume24h, null)
})

test('logs database write failures with request context', async (t) => {
  const repository = new CardRepository(':memory:')
  const logLines: string[] = []
  const app = createApp(
    repository,
    {
      list() {
        return []
      },
      async create() {
        throw new Error('database is locked')
      },
      async update() {
        throw new Error('database is locked')
      }
    },
    undefined,
    {
      logger: {
        level: 'info',
        stream: {
          write(line) {
            logLines.push(line)
          }
        }
      }
    }
  )

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const response = await app.inject({
    method: 'PUT',
    url: '/api/cards/1',
    payload: {
      symbol: 'BTC',
      buyPriceSafe: 100
    }
  })

  assert.equal(response.statusCode, 500)

  const records = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
  const errorRecord = records.find((record) => record.level === 50)

  assert.equal((errorRecord?.err as { message?: string } | undefined)?.message, 'database is locked')
  assert.equal(typeof errorRecord?.reqId, 'string')
})
