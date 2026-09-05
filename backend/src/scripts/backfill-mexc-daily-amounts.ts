import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { MexcClient, MexcClientError } from '../integrations/mexc/index.js'
import { CardRepository } from '../repository.js'

const currentDir = dirname(fileURLToPath(import.meta.url))
const databasePath = resolve(currentDir, '../../data/cards.sqlite')
const repository = new CardRepository(databasePath)
const mexcClient = new MexcClient()

const DAILY_AMOUNT_LOOKBACK_DAYS = 90
const MIN_REQUEST_INTERVAL_MS = 110

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function main() {
  const cards = repository.list().filter((card) => card.mexcDailyAmounts3m === null)

  let updatedCards = 0
  let failedCards = 0
  let lastRequestStartedAt = 0
  const failures: Array<{ symbol: string; reason: string }> = []

  for (const [index, card] of cards.entries()) {
    const now = Date.now()
    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (now - lastRequestStartedAt))

    if (waitMs > 0) {
      await sleep(waitMs)
    }

    lastRequestStartedAt = Date.now()

    try {
      const dailyAmounts = await mexcClient.getUsdtFuturesDailyAmounts(
        `${card.symbol}_USDT`,
        DAILY_AMOUNT_LOOKBACK_DAYS
      )

      repository.update(
        card.id,
        {
          symbol: card.symbol,
          buyPriceSafe: card.buyPriceSafe,
          buyPriceRisk: card.buyPriceRisk,
          sellPrice: card.sellPrice,
          youtubeUrl: card.youtubeUrl,
          telegramPostUrl: card.telegramPostUrl
        },
        {
          mexcDailyAmounts3m: dailyAmounts
        }
      )

      updatedCards += 1
    } catch (error) {
      failedCards += 1

      if (error instanceof MexcClientError && (error.code === 'rate_limit' || error.code === 'cooldown')) {
        throw new Error(
          `Backfill stopped on ${card.symbol}_USDT after ${updatedCards} updates because MEXC rate-limited the client: ${error.message}`
        )
      }

      const reason = error instanceof Error ? error.message : 'Unknown error'
      failures.push({ symbol: card.symbol, reason })
    }

    if ((index + 1) % 25 === 0 || index === cards.length - 1) {
      console.log(
        JSON.stringify(
          {
            processed: index + 1,
            total: cards.length,
            updatedCards,
            failedCards
          },
          null,
          2
        )
      )
    }
  }

  console.log(
    JSON.stringify(
      {
        totalTargets: cards.length,
        updatedCards,
        failedCards,
        failures: failures.slice(0, 20)
      },
      null,
      2
    )
  )
}

try {
  await main()
} finally {
  repository.close()
}
