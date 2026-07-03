import { CardRepository } from '../repository.js'
import type {
  PriceLevelEvent,
  PriceLevelEventKind,
  RatioThresholdEvent,
} from '../types.js'
import {
  TelegramClient,
  type TelegramUpdate,
  type TelegramUser,
} from '../integrations/telegram/client.js'

interface Logger {
  error(message: string, error?: unknown): void
  warn(message: string): void
}

interface TelegramBotServiceOptions {
  repository: CardRepository
  client: TelegramClient
  allowedUserIds: Set<string>
  allowedUsernames: Set<string>
  defaultMinThreshold?: number
  pollTimeoutSeconds?: number
  retryDelayMs?: number
  logger?: Logger
}

interface GroupedRatioThresholdEvent {
  symbol: string
  eventAt: string
  crossedThresholdCount: number
  thresholds: number[]
  maxEventId: number
}

interface GroupedPriceLevelEvent {
  cardId: number
  symbol: string
  eventAt: string
  direction: 'up' | 'down'
  levels: Array<{ kind: PriceLevelEventKind; triggerPrice: number }>
  maxEventId: number
  marketPrice: number
}

const HELP_MESSAGE = [
  'Команды бота:',
  '/start - включить уведомления',
  '/threshold <2-10> - задать минимальный ratio-порог',
  '/status - показать текущие настройки',
  '/stop - отключить уведомления',
  '/help - показать подсказку',
].join('\n')

export class TelegramBotService {
  private readonly repository: CardRepository
  private readonly client: TelegramClient
  private readonly allowedUserIds: Set<string>
  private readonly allowedUsernames: Set<string>
  private readonly defaultMinThreshold: number
  private readonly pollTimeoutSeconds: number
  private readonly retryDelayMs: number
  private readonly logger: Logger
  private running = false
  private nextUpdateId: number | undefined
  private pollPromise: Promise<void> | null = null
  private pollAbortController: AbortController | null = null
  private notificationInProgress = false

  constructor(options: TelegramBotServiceOptions) {
    this.repository = options.repository
    this.client = options.client
    this.allowedUserIds = options.allowedUserIds
    this.allowedUsernames = options.allowedUsernames
    this.defaultMinThreshold = options.defaultMinThreshold ?? 2
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30
    this.retryDelayMs = options.retryDelayMs ?? 3000
    this.logger = options.logger ?? {
      error(message, error) {
        console.error(message, error)
      },
      warn(message) {
        console.warn(message)
      },
    }
  }

  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    this.pollPromise = this.runPollingLoop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.pollAbortController?.abort()

    if (this.pollPromise) {
      await this.pollPromise
      this.pollPromise = null
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message

    if (!message?.text || !message.from) {
      return
    }

    const chatId = String(message.chat.id)

    if (message.chat.type !== 'private') {
      await this.safeSendMessage(
        chatId,
        'Бот работает только в личных сообщениях.',
      )
      return
    }

    if (!this.isAuthorizedUser(message.from)) {
      await this.safeSendMessage(chatId, 'Доступ к боту запрещен.')
      return
    }

    const { command, argument } = this.parseCommand(message.text)

    switch (command) {
      case '/start': {
        const subscriber = this.repository.upsertTelegramSubscriber({
          chatId,
          userId: String(message.from.id),
          username: normalizeUsername(message.from.username),
          firstName: message.from.first_name?.trim() || null,
          defaultMinThreshold: this.defaultMinThreshold,
          currentEventId: this.repository.getLatestRatioThresholdEventId(),
          currentPriceEventId: this.repository.getLatestPriceLevelEventId(),
        })

        await this.safeSendMessage(
          chatId,
          [
            `Уведомления включены. Минимальный порог: x${subscriber.minThreshold}.`,
            HELP_MESSAGE,
          ].join('\n\n'),
        )
        return
      }
      case '/threshold': {
        const threshold = Number(argument)

        if (!Number.isInteger(threshold) || threshold < 2 || threshold > 10) {
          await this.safeSendMessage(
            chatId,
            'Укажите целое значение порога от 2 до 10. Пример: /threshold 4',
          )
          return
        }

        this.repository.upsertTelegramSubscriber({
          chatId,
          userId: String(message.from.id),
          username: normalizeUsername(message.from.username),
          firstName: message.from.first_name?.trim() || null,
          defaultMinThreshold: this.defaultMinThreshold,
          currentEventId: this.repository.getLatestRatioThresholdEventId(),
          currentPriceEventId: this.repository.getLatestPriceLevelEventId(),
        })
        const subscriber = this.repository.setTelegramSubscriberThreshold(
          chatId,
          threshold,
        )

        await this.safeSendMessage(
          chatId,
          `Минимальный ratio-порог обновлен: x${subscriber?.minThreshold ?? threshold}.`,
        )
        return
      }
      case '/status': {
        const subscriber = this.repository.getTelegramSubscriber(chatId)

        if (!subscriber || !subscriber.isActive) {
          await this.safeSendMessage(
            chatId,
            'Уведомления сейчас выключены. Отправьте /start для включения.',
          )
          return
        }

        await this.safeSendMessage(
          chatId,
          `Уведомления активны. Минимальный ratio-порог: x${subscriber.minThreshold}.`,
        )
        return
      }
      case '/stop': {
        const subscriber = this.repository.setTelegramSubscriberActive(
          chatId,
          false,
        )

        await this.safeSendMessage(
          chatId,
          subscriber
            ? 'Уведомления отключены.'
            : 'Уведомления уже были отключены.',
        )
        return
      }
      case '/help':
        await this.safeSendMessage(chatId, HELP_MESSAGE)
        return
      default:
        await this.safeSendMessage(chatId, HELP_MESSAGE)
    }
  }

  async deliverPendingNotifications(): Promise<void> {
    if (this.notificationInProgress) {
      return
    }

    this.notificationInProgress = true

    try {
      const subscribers = this.repository.listActiveTelegramSubscribers()

      for (const subscriber of subscribers) {
        const groupedRatioEvents = this.groupRatioEvents(
          this.repository.listRatioThresholdEventsSince(
            subscriber.lastNotifiedEventId ?? 0,
          ),
        )
        let latestProcessedRatioEventId = subscriber.lastNotifiedEventId ?? 0

        for (const groupedEvent of groupedRatioEvents) {
          const matchingThresholds = groupedEvent.thresholds.filter(
            (threshold) => threshold >= subscriber.minThreshold,
          )

          if (matchingThresholds.length > 0) {
            try {
              await this.client.sendMessage(
                subscriber.chatId,
                this.formatNotificationMessage(
                  groupedEvent,
                  matchingThresholds,
                  subscriber.minThreshold,
                ),
              )
            } catch (error) {
              this.logger.error(
                `Failed to deliver Telegram notification to chat ${subscriber.chatId}.`,
                error,
              )
              break
            }
          }

          latestProcessedRatioEventId = groupedEvent.maxEventId
        }

        const groupedPriceEvents = this.groupPriceLevelEvents(
          this.repository.listPriceLevelEventsSince(
            subscriber.lastNotifiedPriceEventId ?? 0,
          ),
        )
        let latestProcessedPriceEventId =
          subscriber.lastNotifiedPriceEventId ?? 0

        for (const groupedEvent of groupedPriceEvents) {
          try {
            await this.client.sendMessage(
              subscriber.chatId,
              this.formatPriceLevelNotificationMessage(groupedEvent),
            )
          } catch (error) {
            this.logger.error(
              `Failed to deliver Telegram notification to chat ${subscriber.chatId}.`,
              error,
            )
            break
          }

          latestProcessedPriceEventId = groupedEvent.maxEventId
        }

        if (
          latestProcessedRatioEventId > (subscriber.lastNotifiedEventId ?? 0)
        ) {
          this.repository.setTelegramSubscriberLastNotifiedEventId(
            subscriber.chatId,
            latestProcessedRatioEventId,
          )
        }

        if (
          latestProcessedPriceEventId >
          (subscriber.lastNotifiedPriceEventId ?? 0)
        ) {
          this.repository.setTelegramSubscriberLastNotifiedPriceEventId(
            subscriber.chatId,
            latestProcessedPriceEventId,
          )
        }
      }
    } finally {
      this.notificationInProgress = false
    }
  }

  private async runPollingLoop(): Promise<void> {
    try {
      await this.client.deleteWebhook()
    } catch (error) {
      this.logger.error(
        'Failed to delete Telegram webhook before polling.',
        error,
      )
    }

    await this.deliverPendingNotifications()

    while (this.running) {
      this.pollAbortController = new AbortController()

      try {
        const updates = await this.client.getUpdates(
          this.nextUpdateId,
          this.pollTimeoutSeconds,
          this.pollAbortController.signal,
        )

        for (const update of updates) {
          this.nextUpdateId = update.update_id + 1
          await this.handleUpdate(update)
        }
      } catch (error) {
        if (!this.running || this.isAbortError(error)) {
          break
        }

        this.logger.error('Telegram polling failed.', error)
        await sleep(this.retryDelayMs)
      } finally {
        this.pollAbortController = null
      }
    }
  }

  private groupRatioEvents(
    events: RatioThresholdEvent[],
  ): GroupedRatioThresholdEvent[] {
    const grouped: GroupedRatioThresholdEvent[] = []

    for (const event of events) {
      const previous = grouped.at(-1)

      if (
        previous &&
        previous.symbol === event.symbol &&
        previous.eventAt === event.eventAt &&
        previous.crossedThresholdCount === event.crossedThresholdCount
      ) {
        previous.thresholds.push(event.threshold)
        previous.maxEventId = event.id
        continue
      }

      grouped.push({
        symbol: event.symbol,
        eventAt: event.eventAt,
        crossedThresholdCount: event.crossedThresholdCount,
        thresholds: [event.threshold],
        maxEventId: event.id,
      })
    }

    return grouped
  }

  private groupPriceLevelEvents(
    events: PriceLevelEvent[],
  ): GroupedPriceLevelEvent[] {
    const grouped: GroupedPriceLevelEvent[] = []

    for (const event of events) {
      const previous = grouped.at(-1)

      if (
        previous &&
        previous.cardId === event.cardId &&
        previous.symbol === event.symbol &&
        previous.eventAt === event.eventAt &&
        previous.direction === event.direction
      ) {
        previous.levels.push({
          kind: event.kind,
          triggerPrice: event.triggerPrice,
        })
        previous.maxEventId = event.id
        previous.marketPrice = event.marketPrice
        continue
      }

      grouped.push({
        cardId: event.cardId,
        symbol: event.symbol,
        eventAt: event.eventAt,
        direction: event.direction,
        levels: [
          {
            kind: event.kind,
            triggerPrice: event.triggerPrice,
          },
        ],
        maxEventId: event.id,
        marketPrice: event.marketPrice,
      })
    }

    return grouped
  }

  private formatNotificationMessage(
    event: GroupedRatioThresholdEvent,
    matchingThresholds: number[],
    minThreshold: number,
  ): string {
    const thresholdsLabel =
      matchingThresholds.length === 1
        ? `уровень x${matchingThresholds[0]}`
        : `уровни ${matchingThresholds.map((threshold) => `x${threshold}`).join(', ')}`

    return [
      `${event.symbol}: ratio пробил ${thresholdsLabel}.`,
      event.crossedThresholdCount > 1
        ? `За одно обновление пройдено уровней: ${event.crossedThresholdCount}.`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  }

  private formatPriceLevelNotificationMessage(
    event: GroupedPriceLevelEvent,
  ): string {
    const levelsLabel = event.levels
      .map(
        (level) =>
          `${formatPriceLevelKind(level.kind)} ${formatPrice(level.triggerPrice)}`,
      )
      .join(', ')
    const directionLabel =
      event.direction === 'up' ? 'снизу вверх' : 'сверху вниз'

    return [
      `${event.symbol} [card #${event.cardId}]: цена пересекла ${directionLabel} ${levelsLabel}.`,
      `Текущая цена MEXC: ${formatPrice(event.marketPrice)}.`,
    ].join('\n')
  }

  private parseCommand(text: string): {
    command: string
    argument: string | null
  } {
    const [rawCommand = '', ...rest] = text.trim().split(/\s+/u)
    const command = rawCommand.split('@')[0]?.toLowerCase() ?? ''

    return {
      command,
      argument: rest.length > 0 ? rest.join(' ') : null,
    }
  }

  private isAuthorizedUser(user: TelegramUser): boolean {
    if (this.allowedUserIds.has(String(user.id))) {
      return true
    }

    const normalizedUsername = normalizeUsername(user.username)

    return normalizedUsername
      ? this.allowedUsernames.has(normalizedUsername)
      : false
  }

  private async safeSendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.client.sendMessage(chatId, text)
    } catch (error) {
      this.logger.error(
        `Failed to send Telegram message to chat ${chatId}.`,
        error,
      )
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }
}

function normalizeUsername(username: string | undefined): string | null {
  const normalized = username?.trim().replace(/^@/u, '').toLowerCase()

  return normalized ? normalized : null
}

function formatUtcTimestamp(value: string): string {
  return value.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC')
}

function formatPriceLevelKind(kind: PriceLevelEventKind): string {
  switch (kind) {
    case 'buyPriceSafe':
      return 'buyPriceSafe'
    case 'buyPriceRisk':
      return 'buyPriceRisk'
    case 'sellPrice':
      return 'sellPrice'
  }
}

function formatPrice(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value.toFixed(8).replace(/0+$/u, '').replace(/\.$/u, '')
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
