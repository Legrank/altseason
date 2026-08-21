import assert from 'node:assert/strict'
import test from 'node:test'

import { CardRepository } from '../repository.js'
import { TelegramBotService } from './telegram-bot-service.js'
import type {
  TelegramClient,
  TelegramSendMessageOptions,
  TelegramUpdate,
} from '../integrations/telegram/client.js'

class TelegramClientMock {
  readonly messages: Array<{
    chatId: string
    text: string
    options?: TelegramSendMessageOptions
  }> = []

  async deleteWebhook(): Promise<void> {}

  async getUpdates(): Promise<TelegramUpdate[]> {
    return []
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendMessageOptions,
  ): Promise<void> {
    this.messages.push({ chatId, text, options })
  }
}

test('authorizes /start and stores subscriber with default threshold', async (t) => {
  const repository = new CardRepository(':memory:')
  const client = new TelegramClientMock()
  const service = new TelegramBotService({
    repository,
    client: client as unknown as TelegramClient,
    allowedUserIds: new Set(['42']),
    allowedUsernames: new Set(),
    defaultMinThreshold: 4
  })

  t.after(() => {
    repository.close()
  })

  await service.handleUpdate(createMessageUpdate('/start', {
    chatId: 42,
    userId: 42,
    username: 'allowed_user',
    firstName: 'Trader'
  }))

  const subscriber = repository.getTelegramSubscriber('42')

  assert.equal(subscriber?.isActive, true)
  assert.equal(subscriber?.minThreshold, 4)
  assert.equal(subscriber?.lastNotifiedEventId, 0)
  assert.equal(subscriber?.lastNotifiedPriceEventId, 0)
  assert.match(client.messages[0]?.text ?? '', /Минимальный порог: x4/u)
})

test('rejects unauthorized users', async (t) => {
  const repository = new CardRepository(':memory:')
  const client = new TelegramClientMock()
  const service = new TelegramBotService({
    repository,
    client: client as unknown as TelegramClient,
    allowedUserIds: new Set(['99']),
    allowedUsernames: new Set()
  })

  t.after(() => {
    repository.close()
  })

  await service.handleUpdate(createMessageUpdate('/start', {
    chatId: 42,
    userId: 42,
    username: 'blocked',
    firstName: 'Blocked'
  }))

  assert.equal(repository.getTelegramSubscriber('42'), null)
  assert.equal(client.messages[0]?.text, 'Доступ к боту запрещен.')
})

test('updates threshold and sends grouped notifications above subscriber minimum', async (t) => {
  const repository = new CardRepository(':memory:')
  const client = new TelegramClientMock()
  const service = new TelegramBotService({
    repository,
    client: client as unknown as TelegramClient,
    allowedUserIds: new Set(['42']),
    allowedUsernames: new Set()
  })

  repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcAmount24h: 180, mexcDailyAmounts3m: [100, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )

  t.after(() => {
    repository.close()
  })

  await service.handleUpdate(createMessageUpdate('/start', {
    chatId: 42,
    userId: 42,
    username: 'allowed_user',
    firstName: 'Trader'
  }))
  await service.handleUpdate(createMessageUpdate('/threshold 3', {
    chatId: 42,
    userId: 42,
    username: 'allowed_user',
    firstName: 'Trader'
  }))

  repository.applyMexcSnapshot(
    new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 420 }]]),
    '2026-06-29T12:00:00.000Z',
    '2026-06-29'
  )

  await service.deliverPendingNotifications()

  const subscriber = repository.getTelegramSubscriber('42')
  const notification = client.messages.at(-1)?.text ?? ''

  assert.equal(subscriber?.lastNotifiedEventId, 3)
  assert.equal(subscriber?.lastNotifiedPriceEventId, 0)
  assert.match(notification, /BTC: ratio пробил уровни x3, x4\./u)
  assert.match(notification, /Ваш минимальный порог: x3\./u)
  assert.deepEqual(client.messages.at(-1)?.options?.replyMarkup, {
    inline_keyboard: [
      [
        {
          text: 'BTC',
          copy_text: { text: 'BTC' }
        }
      ]
    ]
  })
})

test('sends price-level notifications and advances the price-event cursor', async (t) => {
  const repository = new CardRepository(':memory:')
  const client = new TelegramClientMock()
  const service = new TelegramBotService({
    repository,
    client: client as unknown as TelegramClient,
    allowedUserIds: new Set(['42']),
    allowedUsernames: new Set()
  })

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

  await service.handleUpdate(createMessageUpdate('/start', {
    chatId: 42,
    userId: 42,
    username: 'allowed_user',
    firstName: 'Trader'
  }))

  repository.applyMexcSnapshot(
    new Map([['BTC_USDT', { lastPrice: 125, amount24: 420 }]]),
    '2026-06-29T12:00:00.000Z',
    '2026-06-29'
  )

  await service.deliverPendingNotifications()

  const subscriber = repository.getTelegramSubscriber('42')
  const notification = client.messages.at(-1)?.text ?? ''

  assert.equal(subscriber?.lastNotifiedEventId, 0)
  assert.equal(subscriber?.lastNotifiedPriceEventId, 2)
  assert.match(notification, /BTC \[card #1\]:/u)
  assert.match(notification, /buyPriceSafe 110, buyPriceRisk 120/u)
  assert.deepEqual(client.messages.at(-1)?.options?.replyMarkup, {
    inline_keyboard: [
      [
        {
          text: 'BTC',
          copy_text: { text: 'BTC' }
        }
      ]
    ]
  })
})

test('disables notifications after /stop', async (t) => {
  const repository = new CardRepository(':memory:')
  const client = new TelegramClientMock()
  const service = new TelegramBotService({
    repository,
    client: client as unknown as TelegramClient,
    allowedUserIds: new Set(),
    allowedUsernames: new Set(['allowed_user'])
  })

  t.after(() => {
    repository.close()
  })

  await service.handleUpdate(createMessageUpdate('/start', {
    chatId: 77,
    userId: 42,
    username: 'allowed_user',
    firstName: 'Trader'
  }))
  await service.handleUpdate(createMessageUpdate('/stop', {
    chatId: 77,
    userId: 42,
    username: 'allowed_user',
    firstName: 'Trader'
  }))

  assert.equal(repository.getTelegramSubscriber('77')?.isActive, false)
  assert.equal(client.messages.at(-1)?.text, 'Уведомления отключены.')
})

function createMessageUpdate(
  text: string,
  options: {
    chatId: number
    userId: number
    username?: string
    firstName?: string
  }
): TelegramUpdate {
  return {
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      chat: {
        id: options.chatId,
        type: 'private'
      },
      from: {
        id: options.userId,
        username: options.username,
        first_name: options.firstName
      },
      text
    }
  }
}
