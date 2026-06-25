import Fastify from 'fastify'

import { CardRepository } from './repository.js'
import type { CardPayload } from './types.js'

function normalizePayload(payload: unknown): CardPayload | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }

  const rawSymbol = Reflect.get(payload, 'symbol')
  const rawPrice = Reflect.get(payload, 'price')

  if (typeof rawSymbol !== 'string' || typeof rawPrice !== 'number') {
    return null
  }

  const symbol = rawSymbol.trim().toUpperCase()
  const price = rawPrice

  if (!symbol || !Number.isFinite(price) || price < 0) {
    return null
  }

  return { symbol, price }
}

export function createApp(repository: CardRepository) {
  const app = Fastify({ logger: false })

  app.get('/health', async () => ({ status: 'ok' }))

  app.get('/api/cards', async () => repository.list())

  app.post('/api/cards', async (request, reply) => {
    const payload = normalizePayload(request.body)

    if (!payload) {
      return reply.code(400).send({
        message: 'Invalid payload. "symbol" must be a non-empty string and "price" must be a non-negative number.'
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
        message: 'Invalid payload. "symbol" must be a non-empty string and "price" must be a non-negative number.'
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

