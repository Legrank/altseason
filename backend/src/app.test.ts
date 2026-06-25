import test from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from './app.js'
import { CardRepository } from './repository.js'

function createTestContext() {
  const repository = new CardRepository(':memory:')
  const app = createApp(repository)

  return {
    app,
    repository
  }
}

test('creates a card and returns it in the list', async (t) => {
  const { app, repository } = createTestContext()

  t.after(async () => {
    await app.close()
    repository.close()
  })

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/cards',
    payload: {
      symbol: 'btc',
      price: 102345.67
    }
  })

  assert.equal(createResponse.statusCode, 201)
  const createdCard = createResponse.json()

  assert.equal(createdCard.symbol, 'BTC')
  assert.equal(createdCard.price, 102345.67)
  assert.match(createdCard.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(createdCard.mexcPrice, null)
  assert.equal(createdCard.mexcPriceUpdatedAt, null)
  assert.equal(createdCard.mexcSyncStatus, 'pending')

  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/cards'
  })

  assert.equal(listResponse.statusCode, 200)
  assert.deepEqual(listResponse.json(), [createdCard])
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
      price: 2500
    }
  })

  const card = created.json()
  const updateResponse = await app.inject({
    method: 'PUT',
    url: `/api/cards/${card.id}`,
    payload: {
      symbol: 'sol',
      price: 180.5
    }
  })

  assert.equal(updateResponse.statusCode, 200)
  assert.deepEqual(updateResponse.json(), {
    ...card,
    symbol: 'SOL',
    price: 180.5,
    mexcPrice: null,
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
      price: 1.23
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
        price: 100
      }
    }),
    app.inject({
      method: 'POST',
      url: '/api/cards',
      payload: {
        symbol: 'ADA',
        price: Number.NaN
      }
    })
  ])

  assert.equal(invalidResponses[0].statusCode, 400)
  assert.equal(invalidResponses[1].statusCode, 400)
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
      price: 100
    }
  })

  repository.applyMexcPrice('BTC', 62000.5, '2026-06-23T10:00:00.000Z')

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/cards/${created.json().id}`,
    payload: {
      symbol: 'btc',
      price: 200
    }
  })

  assert.equal(updated.statusCode, 200)
  assert.equal(updated.json().mexcPrice, 62000.5)
  assert.equal(updated.json().mexcPriceUpdatedAt, '2026-06-23T10:00:00.000Z')
  assert.equal(updated.json().mexcSyncStatus, 'synced')
})
