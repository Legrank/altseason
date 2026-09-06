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
const maxVenuesPerCoin = Number(process.argv[3] ?? coingeckoConfig.maxVenuesPerCoin)
const repository = new CardRepository(databasePath)
const service = new CoingeckoListingSyncService({
  repository,
  coingeckoClient: new CoingeckoClient({
    apiKey: coingeckoConfig.apiKey,
    apiKeyKind: coingeckoConfig.apiKeyKind
  }),
  maxVenuesPerCoin,
  logger: {
    info(context, message) {
      console.log(message, context)
    },
    warn(context, message) {
      console.warn(message, describe(context))
    },
    error(context, message) {
      console.error(message, describe(context))
    }
  }
})

function describe(context: Record<string, unknown>): Record<string, unknown> {
  const error = context.err

  return error instanceof Error
    ? { ...context, err: `${error.name}: ${error.message}` }
    : context
}

const result = await service.syncNow()

console.log('\nresult:', result)

if (result !== null) {
  const aggregated = repository
    .listCoinListings()
    .filter((listing) => listing.source === 'coingecko')
  const byExchange = new Map<string, number>()

  for (const listing of aggregated) {
    byExchange.set(listing.exchange, (byExchange.get(listing.exchange) ?? 0) + 1)
  }

  console.log(`\naggregator rows: ${aggregated.length}, distinct venues: ${byExchange.size}`)
  console.log('top venues by card count:')

  for (const [exchange, count] of [...byExchange.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)) {
    console.log(`  ${exchange}: ${count}`)
  }

  for (const symbol of ['BTC', '1000BONK', 'ARKK', 'PURR']) {
    const venues = repository
      .listCoinListingsForSymbol(symbol)
      .filter((listing) => listing.source === 'coingecko')
      .map((listing) => listing.label)

    console.log(`  ${symbol}: ${venues.join(', ') || '(none)'}`)
  }
}

repository.close()
