import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { loadOptionalEnvFiles, readCoingeckoConfig } from '../config.js'
import { CoingeckoClient } from '../integrations/coingecko/index.js'
import { CardRepository } from '../repository.js'
import { CoingeckoListingSyncService } from '../services/coingecko-listing-sync-service.js'

const currentDir = dirname(fileURLToPath(import.meta.url))
loadOptionalEnvFiles([resolve(currentDir, '../../.env.local'), resolve(currentDir, '../../.env')])

const databasePath = process.argv[2] ?? resolve(currentDir, '../../data/cards.sqlite')
const coingeckoConfig = readCoingeckoConfig()
const budget = Number(process.argv[3] ?? 3)
const repository = new CardRepository(databasePath)
const service = new CoingeckoListingSyncService({
  repository,
  coingeckoClient: new CoingeckoClient({
    apiKey: coingeckoConfig.apiKey,
    apiKeyKind: coingeckoConfig.apiKeyKind
  }),
  dailyCoinBudget: budget,
  logger: {
    info(context, message) {
      console.log(message, context)
    },
    warn(context, message) {
      const error = context.err
      console.warn(message, {
        ...context,
        err: error instanceof Error ? `${error.name}: ${error.message}` : error
      })
    },
    error(context, message) {
      const error = context.err
      console.error(message, {
        ...context,
        err: error instanceof Error ? `${error.name}: ${error.message}` : error
      })
    }
  }
})

const queued = repository.getStaleCoingeckoSymbols(budget)
console.log('queued symbols:', queued)

const result = await service.syncNow()
console.log('\nresult:', result)

for (const symbol of queued) {
  const listings = repository
    .listCoinListingsForSymbol(symbol)
    .filter((listing) => listing.source === 'coingecko')

  console.log(
    `  ${symbol}: ${listings.length} aggregator venues` +
      (listings.length > 0
        ? ` -> ${listings
            .slice(0, 8)
            .map((listing) => listing.exchange)
            .join(', ')}`
        : '')
  )
}

repository.close()
