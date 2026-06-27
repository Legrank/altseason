import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { MexcClient } from '../integrations/mexc/index.js'
import { CardRepository } from '../repository.js'

const currentDir = dirname(fileURLToPath(import.meta.url))
const databasePath = resolve(currentDir, '../../data/cards.sqlite')
const repository = new CardRepository(databasePath)
const mexcClient = new MexcClient()

function toBaseSymbol(contractSymbol: string): string | null {
  if (!contractSymbol.endsWith('_USDT')) {
    return null
  }

  const baseSymbol = contractSymbol.slice(0, -'_USDT'.length).trim()
  return baseSymbol ? baseSymbol : null
}

try {
  const contractSymbols = await mexcClient.getUsdtFuturesContractSymbols()
  const baseSymbols = [...new Set(contractSymbols.map(toBaseSymbol).filter((symbol) => symbol !== null))].sort(
    (left, right) => left.localeCompare(right)
  )
  const existingSymbols = new Set(repository.getTrackedSymbols())

  let createdCount = 0

  for (const symbol of baseSymbols) {
    if (existingSymbols.has(symbol)) {
      continue
    }

    repository.create({
      symbol,
      buyPriceSafe: null,
      buyPriceRisk: null,
      sellPrice: null
    })

    existingSymbols.add(symbol)
    createdCount += 1
  }

  console.log(
    JSON.stringify(
      {
        fetchedContracts: contractSymbols.length,
        usdtSymbols: baseSymbols.length,
        createdCards: createdCount,
        skippedExisting: baseSymbols.length - createdCount
      },
      null,
      2
    )
  )
} finally {
  repository.close()
}
