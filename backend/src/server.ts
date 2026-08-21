import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { createApp } from './app.js'
import { loadOptionalEnvFiles, readTelegramBotConfig } from './config.js'
import { MexcClient } from './integrations/mexc/index.js'
import { TelegramClient } from './integrations/telegram/client.js'
import { CardRepository } from './repository.js'
import { CardService } from './services/card-service.js'
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
const app = createApp(repository, cardService)
const telegramConfig = readTelegramBotConfig()
const telegramBotService =
  telegramConfig &&
  (telegramConfig.allowedUserIds.size > 0 || telegramConfig.allowedUsernames.size > 0)
    ? new TelegramBotService({
        repository,
        client: new TelegramClient({ token: telegramConfig.token }),
        allowedUserIds: telegramConfig.allowedUserIds,
        allowedUsernames: telegramConfig.allowedUsernames,
        defaultMinThreshold: telegramConfig.defaultMinThreshold
      })
    : null
const mexcSyncService = new MexcSyncService({
  repository,
  mexcClient,
  onSyncCompleted: telegramBotService ? () => telegramBotService.deliverPendingNotifications() : undefined
})
const mexcContractSyncService = new MexcContractSyncService({
  repository,
  mexcClient,
  onSyncCompleted: () => mexcSyncService.syncNow()
})
const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'

const shutdown = async () => {
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
    console.log(`Backend listening on http://${host}:${port}`)
  })
  .catch(async (error) => {
    console.error(error)
    await shutdown()
    process.exit(1)
  })
