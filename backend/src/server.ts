import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { createApp } from './app.js'
import { MexcClient } from './integrations/mexc/index.js'
import { CardRepository } from './repository.js'
import { CardService } from './services/card-service.js'
import { MexcSyncService } from './services/mexc-sync-service.js'

const currentDir = dirname(fileURLToPath(import.meta.url))
const databasePath = resolve(currentDir, '../data/cards.sqlite')
const repository = new CardRepository(databasePath)
const mexcClient = new MexcClient()
const cardService = new CardService({
  repository,
  dailyVolumeProvider: mexcClient
})
const app = createApp(repository, cardService)
const mexcSyncService = new MexcSyncService({
  repository,
  mexcClient
})
const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'

const shutdown = async () => {
  mexcSyncService.stop()
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
    mexcSyncService.start()
    console.log(`Backend listening on http://${host}:${port}`)
  })
  .catch(async (error) => {
    console.error(error)
    await shutdown()
    process.exit(1)
  })
