import Fastify, { type FastifyServerOptions } from 'fastify'

import { CardRepository } from './repository.js'
import { CardService } from './services/card-service.js'
import { RatioThresholdEventService } from './services/ratio-threshold-event-service.js'
import type { Card, CardPayload, RatioThresholdEvent } from './types.js'

interface CardMutationService {
  list(): Card[]
  create(payload: CardPayload): Promise<Card>
  update(id: number, payload: CardPayload): Promise<Card | null>
}

interface RatioThresholdEventQueryService {
  list(threshold: number): RatioThresholdEvent[]
}

interface AppOptions {
  logger?: FastifyServerOptions['logger']
}

const MAX_URL_LENGTH = 2048

function normalizeOptionalPrice(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }

  return value
}

function normalizeSafePrice(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }

  return value
}

function normalizeOptionalUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const url = value.trim()

  if (!url) {
    return null
  }

  if (url.length > MAX_URL_LENGTH) {
    return undefined
  }

  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined
  }

  return url
}

function normalizePayload(payload: unknown): CardPayload | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }

  const rawSymbol = Reflect.get(payload, 'symbol')
  const rawBuyPriceSafe = Reflect.get(payload, 'buyPriceSafe')
  const rawBuyPriceRisk = Reflect.get(payload, 'buyPriceRisk')
  const rawSellPrice = Reflect.get(payload, 'sellPrice')
  const rawYoutubeUrl = Reflect.get(payload, 'youtubeUrl')
  const rawTelegramPostUrl = Reflect.get(payload, 'telegramPostUrl')

  if (typeof rawSymbol !== 'string') {
    return null
  }

  const symbol = rawSymbol.trim().toUpperCase()
  const buyPriceSafe = normalizeSafePrice(rawBuyPriceSafe)
  const buyPriceRisk = normalizeOptionalPrice(rawBuyPriceRisk)
  const sellPrice = normalizeOptionalPrice(rawSellPrice)
  const youtubeUrl = normalizeOptionalUrl(rawYoutubeUrl)
  const telegramPostUrl = normalizeOptionalUrl(rawTelegramPostUrl)

  if (
    !symbol ||
    buyPriceSafe === undefined ||
    buyPriceRisk === undefined ||
    sellPrice === undefined ||
    youtubeUrl === undefined ||
    telegramPostUrl === undefined
  ) {
    return null
  }

  return {
    symbol,
    buyPriceSafe,
    buyPriceRisk,
    sellPrice,
    youtubeUrl,
    telegramPostUrl
  }
}

export function createApp(
  repository: CardRepository,
  cardMutationService?: CardMutationService,
  ratioThresholdEventQueryService?: RatioThresholdEventQueryService,
  options: AppOptions = {}
) {
  const app = Fastify({ logger: options.logger ?? false })
  const cards = cardMutationService ?? new CardService({ repository })
  const ratioThresholdEvents =
    ratioThresholdEventQueryService ?? new RatioThresholdEventService({ repository })

  app.get('/health', async () => ({ status: 'ok' }))

  app.get('/api/cards', async () => cards.list())

  app.get('/api/ratio-threshold-events', async (request, reply) => {
    const threshold = Number((request.query as { threshold?: string }).threshold)

    if (!Number.isInteger(threshold) || threshold < 2 || threshold > 10) {
      return reply.code(400).send({
        message: 'Invalid threshold. "threshold" query parameter must be an integer between 2 and 10.'
      })
    }

    return ratioThresholdEvents.list(threshold)
  })

  app.get('/api/price-signal-statistics', async () =>
    repository.listPriceSignalStatistics()
  )

  app.post('/api/cards', async (request, reply) => {
    const payload = normalizePayload(request.body)

    if (!payload) {
      return reply.code(400).send({
        message:
          'Invalid payload. "symbol" must be a non-empty string, "buyPriceSafe" must be a non-negative number or null, and optional prices must be non-negative numbers or null.'
      })
    }

    const created = await cards.create(payload)
    request.log.info({ cardId: created.id, symbol: created.symbol }, 'Card created.')

    return reply.code(201).send(created)
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
          'Invalid payload. "symbol" must be a non-empty string, "buyPriceSafe" must be a non-negative number or null, and optional prices must be non-negative numbers or null.'
      })
    }

    const updated = await cards.update(id, payload)

    if (!updated) {
      return reply.code(404).send({ message: 'Card not found.' })
    }

    request.log.info({ cardId: updated.id, symbol: updated.symbol }, 'Card updated.')

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

    request.log.info({ cardId: id }, 'Card deleted.')

    return reply.code(204).send()
  })

  return app
}
