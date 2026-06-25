import assert from 'node:assert/strict'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { CardRepository } from './repository.js'

test('migrates an existing cards table to add renamed manual price columns', () => {
  const databasePath = join(tmpdir(), `altseason-migration-${Date.now()}.sqlite`)
  const legacyDatabase = new DatabaseSync(databasePath)

  legacyDatabase.exec(`
    CREATE TABLE cards (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  legacyDatabase.exec(`
    INSERT INTO cards (symbol, price, created_at)
    VALUES ('BTC', 100, '2026-06-23T00:00:00.000Z')
  `)
  legacyDatabase.close()

  const repository = new CardRepository(databasePath)
  const cards = repository.list()

  assert.equal(cards[0].buyPriceSafe, 100)
  assert.equal(cards[0].buyPriceRisk, null)
  assert.equal(cards[0].sellPrice, null)
  assert.equal(cards[0].mexcPrice, null)
  assert.equal(cards[0].mexcDailyAmounts3m, null)
  assert.equal(cards[0].mexcDailyAmountsUtcDate, null)
  assert.equal(cards[0].mexcPriceUpdatedAt, null)
  assert.equal(cards[0].mexcSyncStatus, 'pending')

  const createResult = repository.create({
    symbol: 'ETH',
    buyPriceSafe: 200,
    buyPriceRisk: null,
    sellPrice: null
  })

  assert.equal(createResult.buyPriceSafe, 200)
  assert.equal(createResult.mexcDailyAmounts3m, null)
  assert.equal(createResult.mexcDailyAmountsUtcDate, null)

  repository.close()
  unlinkSync(databasePath)
})
