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
  assert.equal(cards[0].mexcAmount24h, null)
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
  assert.equal(createResult.mexcAmount24h, null)
  assert.equal(createResult.mexcDailyAmounts3m, null)
  assert.equal(createResult.mexcDailyAmountsUtcDate, null)

  repository.close()
  unlinkSync(databasePath)
})

test('adds mexc_amount_24h and seeds it from existing daily amounts', () => {
  const databasePath = join(tmpdir(), `altseason-amount24-${Date.now()}.sqlite`)
  const existingDatabase = new DatabaseSync(databasePath)

  existingDatabase.exec(`
    CREATE TABLE cards (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      buy_price_safe REAL NULL,
      buy_price_risk REAL NULL,
      sell_price REAL NULL,
      created_at TEXT NOT NULL,
      mexc_price REAL NULL,
      mexc_daily_amounts_3m TEXT NULL,
      mexc_daily_amounts_utc_date TEXT NULL,
      mexc_price_updated_at TEXT NULL,
      mexc_sync_status TEXT NOT NULL DEFAULT 'pending'
    )
  `)
  existingDatabase.exec(`
    INSERT INTO cards (
      symbol,
      buy_price_safe,
      created_at,
      mexc_daily_amounts_3m,
      mexc_daily_amounts_utc_date,
      mexc_sync_status
    )
    VALUES (
      'BTC',
      100,
      '2026-06-23T00:00:00.000Z',
      '[999,888,777]',
      '2026-06-24',
      'synced'
    )
  `)
  existingDatabase.close()

  const repository = new CardRepository(databasePath)
  const migrated = repository.list()[0]
  const reopenedDatabase = new DatabaseSync(databasePath)
  const amount24Column = (
    reopenedDatabase.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>
  ).find((column) => column.name === 'mexc_amount_24h')

  assert.equal(migrated.mexcAmount24h, 999)
  assert.deepEqual(migrated.mexcDailyAmounts3m, [999, 888, 777])
  assert.ok(amount24Column)

  reopenedDatabase.close()
  repository.close()
  unlinkSync(databasePath)
})

test('relaxes buy_price_safe to nullable for an existing cards table', () => {
  const databasePath = join(tmpdir(), `altseason-nullable-${Date.now()}.sqlite`)
  const existingDatabase = new DatabaseSync(databasePath)

  existingDatabase.exec(`
    CREATE TABLE cards (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      buy_price_safe REAL NOT NULL,
      buy_price_risk REAL NULL,
      sell_price REAL NULL,
      created_at TEXT NOT NULL
    )
  `)
  existingDatabase.exec(`
    INSERT INTO cards (symbol, buy_price_safe, buy_price_risk, sell_price, created_at)
    VALUES ('BTC', 100, NULL, NULL, '2026-06-23T00:00:00.000Z')
  `)
  existingDatabase.close()

  const repository = new CardRepository(databasePath)
  const created = repository.create({
    symbol: 'ETH',
    buyPriceSafe: null,
    buyPriceRisk: null,
    sellPrice: null
  })

  const reopenedDatabase = new DatabaseSync(databasePath)
  const columns = reopenedDatabase.prepare('PRAGMA table_info(cards)').all() as Array<{
    name: string
    notnull: number
  }>
  const buyPriceSafeColumn = columns.find((column) => column.name === 'buy_price_safe')

  assert.equal(created.buyPriceSafe, null)
  assert.equal(buyPriceSafeColumn?.notnull, 0)

  reopenedDatabase.close()
  repository.close()
  unlinkSync(databasePath)
})

test('stores telegram subscriber settings and notification cursor', () => {
  const repository = new CardRepository(':memory:')

  repository.create(
    { symbol: 'BTC', buyPriceSafe: 100, buyPriceRisk: null, sellPrice: null },
    { mexcAmount24h: 190, mexcDailyAmounts3m: [100, 100, 100], mexcDailyAmountsUtcDate: '2026-06-29' }
  )
  repository.applyMexcSnapshot(
    new Map([['BTC_USDT', { lastPrice: 62000.1, amount24: 240 }]]),
    '2026-06-29T12:00:00.000Z',
    '2026-06-29'
  )

  const created = repository.upsertTelegramSubscriber({
    chatId: '101',
    userId: '202',
    username: 'trader',
    firstName: 'Alt',
    defaultMinThreshold: 3,
    currentEventId: repository.getLatestRatioThresholdEventId(),
    currentPriceEventId: repository.getLatestPriceLevelEventId()
  })

  assert.equal(created.chatId, '101')
  assert.equal(created.minThreshold, 3)
  assert.equal(created.isActive, true)
  assert.equal(created.lastNotifiedEventId, 1)
  assert.equal(created.lastNotifiedPriceEventId, 0)

  const updatedThreshold = repository.setTelegramSubscriberThreshold('101', 5)
  const paused = repository.setTelegramSubscriberActive('101', false)
  const resumed = repository.upsertTelegramSubscriber({
    chatId: '101',
    userId: '202',
    username: 'trader',
    firstName: 'Alt',
    defaultMinThreshold: 2,
    currentEventId: repository.getLatestRatioThresholdEventId(),
    currentPriceEventId: repository.getLatestPriceLevelEventId()
  })
  const movedCursor = repository.setTelegramSubscriberLastNotifiedEventId('101', 7)
  const movedPriceCursor = repository.setTelegramSubscriberLastNotifiedPriceEventId('101', 9)

  assert.equal(updatedThreshold?.minThreshold, 5)
  assert.equal(paused?.isActive, false)
  assert.equal(resumed.minThreshold, 5)
  assert.equal(resumed.isActive, true)
  assert.equal(movedCursor?.lastNotifiedEventId, 7)
  assert.equal(movedPriceCursor?.lastNotifiedPriceEventId, 9)
  assert.deepEqual(repository.listActiveTelegramSubscribers().map((subscriber) => subscriber.chatId), ['101'])

  repository.close()
})
