import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { loadOptionalEnvFiles, readDisabledExchangeIds } from '../config.js'
import { createDefaultExchangeClients } from '../integrations/exchanges/index.js'
import { CardRepository } from '../repository.js'
import { ExchangeListingSyncService } from '../services/exchange-listing-sync-service.js'

const currentDir = dirname(fileURLToPath(import.meta.url))
loadOptionalEnvFiles([resolve(currentDir, '../../.env.local'), resolve(currentDir, '../../.env')])

const databasePath = process.argv[2] ?? resolve(currentDir, '../../data/cards.sqlite')
const disabledExchangeIds = readDisabledExchangeIds()
const repository = new CardRepository(databasePath)
const service = new ExchangeListingSyncService({
  repository,
  exchangeClients: createDefaultExchangeClients().filter(
    (client) => !disabledExchangeIds.has(client.id)
  ),
  logger: {
    info(context, message) {
      console.log(message, context)
    },
    warn(context, message) {
      console.warn(message, context)
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

const result = await service.syncNow()

console.log('\nresult:', result)

const listings = repository.listCoinListings()
const bySymbol = new Map<string, Set<string>>()

for (const listing of listings) {
  const existing = bySymbol.get(listing.symbol) ?? new Set<string>()
  existing.add(listing.exchange)
  bySymbol.set(listing.symbol, existing)
}

const cardCount = repository.getTrackedSymbols().length
const histogram = new Map<number, number>()

for (const symbol of repository.getTrackedSymbols()) {
  const count = bySymbol.get(symbol)?.size ?? 0
  histogram.set(count, (histogram.get(count) ?? 0) + 1)
}

console.log(`\ncards: ${cardCount}, listing rows: ${listings.length}`)

for (const [count, cards] of [...histogram.entries()].sort((left, right) => left[0] - right[0])) {
  console.log(`  on ${count} exchange(s): ${cards} cards`)
}

for (const symbol of ['BTC', '1000BONK', '1000000MOG', 'ARKK']) {
  const exchanges = [...(bySymbol.get(symbol) ?? [])].sort()
  console.log(`  ${symbol}: ${exchanges.join(', ') || '(none)'}`)
}

repository.close()
