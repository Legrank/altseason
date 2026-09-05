import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { createApp } from './app.js'
import {
  loadOptionalEnvFiles,
  readCoingeckoConfig,
  readDisabledExchangeIds,
  readTelegramBotConfig
} from './config.js'
import { CoingeckoClient } from './integrations/coingecko/index.js'
import { createDefaultExchangeClients } from './integrations/exchanges/index.js'
import { MexcClient } from './integrations/mexc/index.js'
import { TelegramClient } from './integrations/telegram/client.js'
import { CardRepository } from './repository.js'
import { CardService } from './services/card-service.js'
import { CoingeckoListingSyncService } from './services/coingecko-listing-sync-service.js'
import { ExchangeListingSyncService } from './services/exchange-listing-sync-service.js'
import { MexcContractSyncService } from './services/mexc-contract-sync-service.js'
import { MexcSyncService } from './services/mexc-sync-service.js'
import { TelegramBotService } from './services/telegram-bot-service.js'

const currentDir = dirname(fileURLToPath(import.meta.url))
loadOptionalEnvFiles([resolve(currentDir, '../.env.local'), resolve(currentDir, '../.env')])

const databasePath = resolve(currentDir, '../data/cards.sqlite')
const repository = new CardRepository(databasePath)
const mexcClient = new MexcClient()
const cardService = new CardService({
  repository,
  dailyVolumeProvider: mexcClient
})
const app = createApp(repository, cardService, undefined, {
  logger: {
    level: process.env.LOG_LEVEL?.trim() || 'info',
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      censor: '[REDACTED]'
    }
  }
})
const telegramConfig = readTelegramBotConfig()
const telegramBotService =
  telegramConfig &&
  (telegramConfig.allowedUserIds.size > 0 || telegramConfig.allowedUsernames.size > 0)
    ? new TelegramBotService({
        repository,
        client: new TelegramClient({ token: telegramConfig.token }),
        allowedUserIds: telegramConfig.allowedUserIds,
        allowedUsernames: telegramConfig.allowedUsernames,
        defaultMinThreshold: telegramConfig.defaultMinThreshold,
        logger: {
          error(message, error) {
            app.log.error({ err: error }, message)
          },
          warn(message) {
            app.log.warn(message)
          }
        }
      })
    : null
const mexcSyncService = new MexcSyncService({
  repository,
  mexcClient,
  logger: app.log,
  onSyncCompleted: telegramBotService ? () => telegramBotService.deliverPendingNotifications() : undefined
})
const disabledExchangeIds = readDisabledExchangeIds()
const exchangeListingSyncService = new ExchangeListingSyncService({
  repository,
  exchangeClients: createDefaultExchangeClients().filter(
    (client) => !disabledExchangeIds.has(client.id)
  ),
  logger: app.log
})
const mexcContractSyncService = new MexcContractSyncService({
  repository,
  mexcClient,
  logger: app.log,
  onSyncCompleted: async () => {
    await mexcSyncService.syncNow()
    // The catalog has just changed, so the venue list for the new cards is stale by definition.
    await exchangeListingSyncService.syncNow()
  }
})
const coingeckoConfig = readCoingeckoConfig()
const coingeckoListingSyncService = coingeckoConfig.enabled
  ? new CoingeckoListingSyncService({
      repository,
      coingeckoClient: new CoingeckoClient({
        apiKey: coingeckoConfig.apiKey,
        apiKeyKind: coingeckoConfig.apiKeyKind
      }),
      dailyCoinBudget: coingeckoConfig.dailyCoinBudget,
      logger: app.log
    })
  : null
const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'

const shutdown = async () => {
  coingeckoListingSyncService?.stop()
  exchangeListingSyncService.stop()
  mexcContractSyncService.stop()
  mexcSyncService.stop()
  await telegramBotService?.stop()
  await app.close()
  repository.close()
}

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0))
})

process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0))
})

app
  .listen({ port, host })
  .then(() => {
    if (telegramConfig && !telegramBotService) {
      console.warn(
        'Telegram bot token is configured, but TELEGRAM_ALLOWED_USER_IDS or TELEGRAM_ALLOWED_USERNAMES is empty. Bot startup skipped.'
      )
    }

    telegramBotService?.start()
    mexcContractSyncService.start()
    mexcSyncService.start()
    exchangeListingSyncService.start()
    coingeckoListingSyncService?.start()
    console.log(`Backend listening on http://${host}:${port}`)
  })
  .catch(async (error) => {
    console.error(error)
    await shutdown()
    process.exit(1)
  })
