import Fastify from 'fastify'

import { CardRepository } from './repository.js'
import type { CardPayload } from './types.js'

function normalizeOptionalPrice(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }

  return value
}

function normalizePayload(payload: unknown): CardPayload | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }

  const rawSymbol = Reflect.get(payload, 'symbol')
  const rawBuyPriceSafe = Reflect.get(payload, 'buyPriceSafe')
  const rawBuyPriceRisk = Reflect.get(payload, 'buyPriceRisk')
  const rawSellPrice = Reflect.get(payload, 'sellPrice')

  if (typeof rawSymbol !== 'string' || typeof rawBuyPriceSafe !== 'number') {
    return null
  }

  const symbol = rawSymbol.trim().toUpperCase()
  const buyPriceSafe = rawBuyPriceSafe
  const buyPriceRisk = normalizeOptionalPrice(rawBuyPriceRisk)
  const sellPrice = normalizeOptionalPrice(rawSellPrice)

  if (
    !symbol ||
    !Number.isFinite(buyPriceSafe) ||
    buyPriceSafe < 0 ||
    buyPriceRisk === undefined ||
    sellPrice === undefined
  ) {
    return null
  }

  return {
    symbol,
    buyPriceSafe,
    buyPriceRisk,
    sellPrice
  }
}

export function createApp(repository: CardRepository) {
  const app = Fastify({ logger: false })

  app.get('/health', async () => ({ status: 'ok' }))

  app.get('/api/cards', async () => repository.list())

  app.post('/api/cards', async (request, reply) => {
    const payload = normalizePayload(request.body)

    if (!payload) {
      return reply.code(400).send({
        message:
          'Invalid payload. "symbol" must be a non-empty string, "buyPriceSafe" must be a non-negative number, and optional prices must be non-negative numbers or null.'
      })
    }

    return reply.code(201).send(repository.create(payload))
  })

  app.put('/api/cards/:id', async (request, reply) => {
    const id = Number((request.params as { id?: string }).id)
    const payload = normalizePayload(request.body)

    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ message: 'Invalid card id.' })
    }

    if (!payload) {
      return reply.code(400).send({
        message:
          'Invalid payload. "symbol" must be a non-empty string, "buyPriceSafe" must be a non-negative number, and optional prices must be non-negative numbers or null.'
      })
    }

    const updated = repository.update(id, payload)

    if (!updated) {
      return reply.code(404).send({ message: 'Card not found.' })
    }

    return updated
  })

  app.delete('/api/cards/:id', async (request, reply) => {
    const id = Number((request.params as { id?: string }).id)

    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ message: 'Invalid card id.' })
    }

    const deleted = repository.delete(id)

    if (!deleted) {
      return reply.code(404).send({ message: 'Card not found.' })
    }

    return reply.code(204).send()
  })

  return app
}
