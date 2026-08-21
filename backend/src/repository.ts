import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { calculateRobustAverage } from './services/robust-average.js'
import type {
  CardPayload,
  MexcSyncStatus,
  PriceLevelEvent,
  PriceLevelEventDirection,
  PriceLevelEventKind,
  RatioThresholdEvent,
  StoredCard,
  TelegramSubscriber
} from './types.js'

const RATIO_EVENT_THRESHOLDS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const
const RATIO_EVENT_RETENTION_DAYS = 30
const PRICE_LEVEL_EVENT_RETENTION_DAYS = 30

interface CardRow {
  id: number
  symbol: string
  buy_price_safe: number | null
  buy_price_risk: number | null
  sell_price: number | null
  buy_price_safe_max_observed: number | null
  buy_price_risk_max_observed: number | null
  sell_price_min_observed: number | null
  created_at: string
  mexc_price: number | null
  mexc_amount_24h: number | null
  mexc_daily_amounts_3m: string | null
  mexc_daily_amounts_utc_date: string | null
  mexc_price_updated_at: string | null
  mexc_sync_status: MexcSyncStatus
}

interface MexcSyncCardRow {
  id: number
  symbol: string
  buy_price_safe: number | null
  buy_price_risk: number | null
  sell_price: number | null
  buy_price_safe_max_observed: number | null
  buy_price_risk_max_observed: number | null
  sell_price_min_observed: number | null
  mexc_price: number | null
  mexc_amount_24h: number | null
  mexc_daily_amounts_3m: string | null
  mexc_daily_amounts_utc_date: string | null
}

interface RatioThresholdEventRow {
  id: number
  symbol: string
  threshold: number
  event_at: string
  crossed_threshold_count: number
}

interface TelegramSubscriberRow {
  chat_id: string
  user_id: string
  username: string | null
  first_name: string | null
  min_threshold: number
  is_active: number
  created_at: string
  updated_at: string
  last_notified_event_id: number | null
  last_notified_price_event_id: number | null
}

interface PriceLevelEventRow {
  id: number
  card_id: number
  symbol: string
  kind: PriceLevelEventKind
  direction: PriceLevelEventDirection
  trigger_price: number
  market_price: number
  event_at: string
}

interface ColumnInfoRow {
  name: string
  notnull: number
}

export interface UsdtContractCardSyncResult {
  createdCount: number
  deletedCount: number
}

const USDT_CONTRACT_SYNC_COMPLETED_AT_KEY = 'mexc_usdt_contract_sync_completed_at'

export class CardRepository {
  private readonly db: DatabaseSync
  private readonly usesFileDatabase: boolean

  constructor(databasePath: string) {
    this.usesFileDatabase = databasePath !== ':memory:'

    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true })
    }

    this.db = new DatabaseSync(databasePath)
    this.configureDatabase()
    this.initializeSchema()
  }

  list(): StoredCard[] {
    const statement = this.db.prepare(`
      SELECT id, symbol, buy_price_safe, buy_price_risk, sell_price, buy_price_safe_max_observed, buy_price_risk_max_observed, sell_price_min_observed, created_at, mexc_price, mexc_amount_24h, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date, mexc_price_updated_at, mexc_sync_status
      FROM cards
      ORDER BY created_at DESC, id DESC
    `)

    return (statement.all() as unknown as CardRow[]).map((row) => this.mapCardRow(row))
  }

  create(
    payload: CardPayload,
    options?: {
      mexcAmount24h?: number | null
      mexcDailyAmounts3m?: number[] | null
      mexcDailyAmountsUtcDate?: string | null
    }
  ): StoredCard {
    const createdAt = new Date().toISOString()
    const mexcAmount24h = options?.mexcAmount24h ?? null
    const mexcDailyAmounts3m = options?.mexcDailyAmounts3m ?? null
    const mexcDailyAmountsUtcDate = options?.mexcDailyAmountsUtcDate ?? null
    const statement = this.db.prepare(`
      INSERT INTO cards (symbol, buy_price_safe, buy_price_risk, sell_price, buy_price_safe_max_observed, buy_price_risk_max_observed, sell_price_min_observed, created_at, mexc_amount_24h, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = statement.run(
      payload.symbol,
      payload.buyPriceSafe,
      payload.buyPriceRisk,
      payload.sellPrice,
      payload.buyPriceSafe,
      payload.buyPriceRisk,
      payload.sellPrice,
      createdAt,
      mexcAmount24h,
      this.serializeDailyAmounts(mexcDailyAmounts3m),
      mexcDailyAmountsUtcDate
    )
    const id = Number(result.lastInsertRowid)

    return {
      id,
      symbol: payload.symbol,
      buyPriceSafe: payload.buyPriceSafe,
      buyPriceRisk: payload.buyPriceRisk,
      sellPrice: payload.sellPrice,
      buyPriceSafeMaxObserved: payload.buyPriceSafe,
      buyPriceRiskMaxObserved: payload.buyPriceRisk,
      sellPriceMinObserved: payload.sellPrice,
      createdAt,
      mexcPrice: null,
      mexcAmount24h,
      mexcDailyAmounts3m,
      mexcDailyAmountsUtcDate,
      mexcPriceUpdatedAt: null,
      mexcSyncStatus: 'pending'
    }
  }

  update(
    id: number,
    payload: CardPayload,
    options?: {
      mexcAmount24h?: number | null
      mexcDailyAmounts3m?: number[] | null
      mexcDailyAmountsUtcDate?: string | null
    }
  ): StoredCard | null {
    const existing = this.getById(id)

    if (!existing) {
      return null
    }

    const symbolChanged = existing.symbol !== payload.symbol
    const buyPriceSafeChanged = symbolChanged || existing.buyPriceSafe !== payload.buyPriceSafe
    const buyPriceRiskChanged = symbolChanged || existing.buyPriceRisk !== payload.buyPriceRisk
    const sellPriceChanged = symbolChanged || existing.sellPrice !== payload.sellPrice
    const nextBuyPriceSafeMaxObserved = buyPriceSafeChanged
      ? payload.buyPriceSafe
      : existing.buyPriceSafeMaxObserved
    const nextBuyPriceRiskMaxObserved = buyPriceRiskChanged
      ? payload.buyPriceRisk
      : existing.buyPriceRiskMaxObserved
    const nextSellPriceMinObserved = sellPriceChanged ? payload.sellPrice : existing.sellPriceMinObserved
    const nextMexcAmount24h =
      options?.mexcAmount24h === undefined
        ? symbolChanged
          ? null
          : existing.mexcAmount24h
        : options.mexcAmount24h
    const nextMexcDailyAmounts3m =
      options?.mexcDailyAmounts3m === undefined ? existing.mexcDailyAmounts3m : options.mexcDailyAmounts3m
    const nextMexcDailyAmountsUtcDate =
      options?.mexcDailyAmountsUtcDate === undefined
        ? existing.mexcDailyAmountsUtcDate
        : options.mexcDailyAmountsUtcDate

    const statement = this.db.prepare(`
      UPDATE cards
      SET symbol = ?, buy_price_safe = ?, buy_price_risk = ?, sell_price = ?, buy_price_safe_max_observed = ?, buy_price_risk_max_observed = ?, sell_price_min_observed = ?, mexc_price = ?, mexc_amount_24h = ?, mexc_daily_amounts_3m = ?, mexc_daily_amounts_utc_date = ?, mexc_price_updated_at = ?, mexc_sync_status = ?
      WHERE id = ?
    `)

    statement.run(
      payload.symbol,
      payload.buyPriceSafe,
      payload.buyPriceRisk,
      payload.sellPrice,
      nextBuyPriceSafeMaxObserved,
      nextBuyPriceRiskMaxObserved,
      nextSellPriceMinObserved,
      symbolChanged ? null : existing.mexcPrice,
      nextMexcAmount24h,
      this.serializeDailyAmounts(nextMexcDailyAmounts3m),
      nextMexcDailyAmountsUtcDate,
      symbolChanged ? null : existing.mexcPriceUpdatedAt,
      symbolChanged ? 'pending' : existing.mexcSyncStatus,
      id
    )

    return {
      ...existing,
      symbol: payload.symbol,
      buyPriceSafe: payload.buyPriceSafe,
      buyPriceRisk: payload.buyPriceRisk,
      sellPrice: payload.sellPrice,
      buyPriceSafeMaxObserved: nextBuyPriceSafeMaxObserved,
      buyPriceRiskMaxObserved: nextBuyPriceRiskMaxObserved,
      sellPriceMinObserved: nextSellPriceMinObserved,
      mexcPrice: symbolChanged ? null : existing.mexcPrice,
      mexcAmount24h: nextMexcAmount24h,
      mexcDailyAmounts3m: nextMexcDailyAmounts3m,
      mexcDailyAmountsUtcDate: nextMexcDailyAmountsUtcDate,
      mexcPriceUpdatedAt: symbolChanged ? null : existing.mexcPriceUpdatedAt,
      mexcSyncStatus: symbolChanged ? 'pending' : existing.mexcSyncStatus
    }
  }

  delete(id: number): boolean {
    const statement = this.db.prepare(`
      DELETE FROM cards
      WHERE id = ?
    `)
    const result = statement.run(id)

    return result.changes > 0
  }

  close(): void {
    this.db.close()
  }

  getTrackedSymbols(): string[] {
    const statement = this.db.prepare(`
      SELECT DISTINCT symbol
      FROM cards
      ORDER BY symbol ASC
    `)
    const rows = statement.all() as unknown as Array<{ symbol: string }>

    return rows.map((row) => row.symbol)
  }

  getUsdtContractSyncCompletedAt(): string | null {
    const row = this.db
      .prepare(`
        SELECT value
        FROM app_metadata
        WHERE key = ?
      `)
      .get(USDT_CONTRACT_SYNC_COMPLETED_AT_KEY) as { value: string } | undefined

    return row?.value ?? null
  }

  syncUsdtContractCards(
    symbols: readonly string[],
    completedAt: string
  ): UsdtContractCardSyncResult {
    const normalizedSymbols = [
      ...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))
    ]

    // An empty exchange response must never be allowed to wipe the local catalog.
    if (normalizedSymbols.length === 0) {
      throw new Error('Cannot synchronize cards from an empty USDT contract list.')
    }

    return this.withTransaction(() => {
      const existingRows = this.db
        .prepare('SELECT id, symbol FROM cards ORDER BY id ASC')
        .all() as unknown as Array<{ id: number; symbol: string }>
      const existingSymbols = new Set(existingRows.map((row) => row.symbol))
      const nextSymbols = new Set(normalizedSymbols)
      const insertCard = this.db.prepare(`
        INSERT INTO cards (
          symbol,
          buy_price_safe,
          buy_price_risk,
          sell_price,
          buy_price_safe_max_observed,
          buy_price_risk_max_observed,
          sell_price_min_observed,
          created_at
        )
        VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
      `)
      const deletePriceEvents = this.db.prepare('DELETE FROM price_level_events WHERE card_id = ?')
      const deleteRatioEvents = this.db.prepare('DELETE FROM ratio_threshold_events WHERE symbol = ?')
      const deleteCard = this.db.prepare('DELETE FROM cards WHERE id = ?')
      let createdCount = 0
      let deletedCount = 0

      for (const symbol of normalizedSymbols) {
        if (existingSymbols.has(symbol)) {
          continue
        }

        insertCard.run(symbol, completedAt)
        createdCount += 1
      }

      for (const row of existingRows) {
        if (nextSymbols.has(row.symbol)) {
          continue
        }

        deletePriceEvents.run(row.id)
        deleteRatioEvents.run(row.symbol)
        deleteCard.run(row.id)
        deletedCount += 1
      }

      this.db
        .prepare(`
          INSERT INTO app_metadata (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `)
        .run(USDT_CONTRACT_SYNC_COMPLETED_AT_KEY, completedAt)

      return { createdCount, deletedCount }
    })
  }

  listRatioThresholdEvents(threshold: number): RatioThresholdEvent[] {
    const statement = this.db.prepare(`
      SELECT id, symbol, threshold, event_at, crossed_threshold_count
      FROM ratio_threshold_events
      WHERE threshold = ?
      ORDER BY event_at DESC, id DESC
    `)

    return (statement.all(threshold) as unknown as RatioThresholdEventRow[]).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      threshold: row.threshold,
      eventAt: row.event_at,
      crossedThresholdCount: row.crossed_threshold_count
    }))
  }

  listRatioThresholdEventsSince(afterId: number): RatioThresholdEvent[] {
    const statement = this.db.prepare(`
      SELECT id, symbol, threshold, event_at, crossed_threshold_count
      FROM ratio_threshold_events
      WHERE id > ?
      ORDER BY id ASC
    `)

    return (statement.all(afterId) as unknown as RatioThresholdEventRow[]).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      threshold: row.threshold,
      eventAt: row.event_at,
      crossedThresholdCount: row.crossed_threshold_count
    }))
  }

  getLatestRatioThresholdEventId(): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(MAX(id), 0) AS id
        FROM ratio_threshold_events
      `)
      .get() as { id: number } | undefined

    return row?.id ?? 0
  }

  listPriceLevelEventsSince(afterId: number): PriceLevelEvent[] {
    const statement = this.db.prepare(`
      SELECT id, card_id, symbol, kind, direction, trigger_price, market_price, event_at
      FROM price_level_events
      WHERE id > ?
      ORDER BY id ASC
    `)

    return (statement.all(afterId) as unknown as PriceLevelEventRow[]).map((row) =>
      this.mapPriceLevelEventRow(row)
    )
  }

  getLatestPriceLevelEventId(): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(MAX(id), 0) AS id
        FROM price_level_events
      `)
      .get() as { id: number } | undefined

    return row?.id ?? 0
  }

  getTelegramSubscriber(chatId: string): TelegramSubscriber | null {
    const row = this.db
      .prepare(`
        SELECT chat_id, user_id, username, first_name, min_threshold, is_active, created_at, updated_at, last_notified_event_id, last_notified_price_event_id
        FROM telegram_subscribers
        WHERE chat_id = ?
      `)
      .get(chatId) as TelegramSubscriberRow | undefined

    return row ? this.mapTelegramSubscriberRow(row) : null
  }

  listActiveTelegramSubscribers(): TelegramSubscriber[] {
    const statement = this.db.prepare(`
      SELECT chat_id, user_id, username, first_name, min_threshold, is_active, created_at, updated_at, last_notified_event_id, last_notified_price_event_id
      FROM telegram_subscribers
      WHERE is_active = 1
      ORDER BY created_at ASC, chat_id ASC
    `)

    return (statement.all() as unknown as TelegramSubscriberRow[]).map((row) =>
      this.mapTelegramSubscriberRow(row)
    )
  }

  upsertTelegramSubscriber(input: {
    chatId: string
    userId: string
    username: string | null
    firstName: string | null
    defaultMinThreshold: number
    currentEventId: number
    currentPriceEventId: number
  }): TelegramSubscriber {
    const existing = this.getTelegramSubscriber(input.chatId)
    const timestamp = new Date().toISOString()

    this.db
      .prepare(`
        INSERT INTO telegram_subscribers (
          chat_id,
          user_id,
          username,
          first_name,
          min_threshold,
          is_active,
          created_at,
          updated_at,
          last_notified_event_id,
          last_notified_price_event_id
        )
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          user_id = excluded.user_id,
          username = excluded.username,
          first_name = excluded.first_name,
          is_active = 1,
          updated_at = excluded.updated_at
      `)
      .run(
        input.chatId,
        input.userId,
        input.username,
        input.firstName,
        existing?.minThreshold ?? input.defaultMinThreshold,
        existing?.createdAt ?? timestamp,
        timestamp,
        existing?.lastNotifiedEventId ?? input.currentEventId,
        existing?.lastNotifiedPriceEventId ?? input.currentPriceEventId
      )

    return this.getTelegramSubscriber(input.chatId) as TelegramSubscriber
  }

  setTelegramSubscriberThreshold(chatId: string, minThreshold: number): TelegramSubscriber | null {
    const timestamp = new Date().toISOString()
    const result = this.db
      .prepare(`
        UPDATE telegram_subscribers
        SET min_threshold = ?, is_active = 1, updated_at = ?
        WHERE chat_id = ?
      `)
      .run(minThreshold, timestamp, chatId)

    return result.changes > 0 ? this.getTelegramSubscriber(chatId) : null
  }

  setTelegramSubscriberActive(chatId: string, isActive: boolean): TelegramSubscriber | null {
    const timestamp = new Date().toISOString()
    const result = this.db
      .prepare(`
        UPDATE telegram_subscribers
        SET is_active = ?, updated_at = ?
        WHERE chat_id = ?
      `)
      .run(isActive ? 1 : 0, timestamp, chatId)

    return result.changes > 0 ? this.getTelegramSubscriber(chatId) : null
  }

  setTelegramSubscriberLastNotifiedEventId(chatId: string, lastNotifiedEventId: number): TelegramSubscriber | null {
    const timestamp = new Date().toISOString()
    const result = this.db
      .prepare(`
        UPDATE telegram_subscribers
        SET last_notified_event_id = ?, updated_at = ?
        WHERE chat_id = ?
      `)
      .run(lastNotifiedEventId, timestamp, chatId)

    return result.changes > 0 ? this.getTelegramSubscriber(chatId) : null
  }

  setTelegramSubscriberLastNotifiedPriceEventId(
    chatId: string,
    lastNotifiedPriceEventId: number
  ): TelegramSubscriber | null {
    const timestamp = new Date().toISOString()
    const result = this.db
      .prepare(`
        UPDATE telegram_subscribers
        SET last_notified_price_event_id = ?, updated_at = ?
        WHERE chat_id = ?
      `)
      .run(lastNotifiedPriceEventId, timestamp, chatId)

    return result.changes > 0 ? this.getTelegramSubscriber(chatId) : null
  }

  applyMexcPrice(
    symbol: string,
    mexcPrice: number,
    updatedAt: string,
    options?: { amount24?: number | null; utcDate?: string }
  ): void {
    const cards = this.getCardsForMexcSync(symbol)

    if (cards.length === 0) {
      return
    }

    this.withTransaction(() => {
      this.applySyncedMexcRows(cards, mexcPrice, updatedAt, options)
      const utcDate = options?.utcDate ?? updatedAt.slice(0, 10)

      for (const card of cards) {
        this.insertPriceLevelEventsForCard(card, mexcPrice, updatedAt, utcDate)
      }

      this.deleteExpiredPriceLevelEvents(updatedAt)
    })
  }

  markMexcNotFound(symbol: string): void {
    const statement = this.db.prepare(`
      UPDATE cards
      SET mexc_price = NULL, mexc_amount_24h = NULL, mexc_price_updated_at = NULL, mexc_sync_status = 'not_found'
      WHERE symbol = ?
    `)

    statement.run(symbol)
  }

  markPendingMexcSyncError(): void {
    const statement = this.db.prepare(`
      UPDATE cards
      SET mexc_sync_status = 'error'
      WHERE mexc_sync_status = 'pending'
    `)

    statement.run()
  }

  applyMexcSnapshot(
    snapshot: Map<string, { lastPrice: number; amount24: number | null }>,
    updatedAt: string,
    utcDate: string
  ): void {
    const cards = this.getCardsForMexcSync()

    if (cards.length === 0) {
      return
    }

    this.withTransaction(() => {
      const updateSyncedStatement = this.db.prepare(`
        UPDATE cards
        SET mexc_price = ?, mexc_amount_24h = ?, mexc_daily_amounts_3m = ?, mexc_daily_amounts_utc_date = ?, mexc_price_updated_at = ?, mexc_sync_status = 'synced', buy_price_safe_max_observed = ?, buy_price_risk_max_observed = ?, sell_price_min_observed = ?
        WHERE id = ?
      `)
      const markNotFoundStatement = this.db.prepare(`
        UPDATE cards
        SET mexc_price = NULL, mexc_amount_24h = NULL, mexc_price_updated_at = NULL, mexc_sync_status = 'not_found'
        WHERE id = ?
      `)

      for (const card of cards) {
        const marketSnapshot = snapshot.get(`${card.symbol}_USDT`)

        if (!marketSnapshot) {
          markNotFoundStatement.run(card.id)
          continue
        }

        const previousDailyAmounts = this.parseDailyAmounts(card.mexc_daily_amounts_3m)
        const previousRatio = this.calculateRatio(card.mexc_amount_24h, previousDailyAmounts)

        const nextDailyAmounts =
          typeof marketSnapshot.amount24 === 'number'
            ? this.rollDailyAmounts(
                previousDailyAmounts,
                card.mexc_daily_amounts_utc_date,
                marketSnapshot.amount24,
                utcDate
              )
            : {
                values: previousDailyAmounts,
                utcDate: card.mexc_daily_amounts_utc_date
              }

        const nextRatio = this.calculateRatio(marketSnapshot.amount24, nextDailyAmounts.values)
        const crossedThresholds = this.detectCrossedThresholds(previousRatio, nextRatio)
        const eligibleThresholds = this.filterThresholdsByPreviousDayVolume(
          crossedThresholds,
          marketSnapshot.amount24,
          this.getLatestCompletedDailyAmount(nextDailyAmounts.values)
        )
        const thresholdsToInsert = this.filterLoggedThresholdsForUtcDay(
          card.symbol,
          eligibleThresholds,
          utcDate
        )
        const priceLevelEventsToInsert = this.detectPriceLevelEvents(card, marketSnapshot.lastPrice, utcDate)

        updateSyncedStatement.run(
          marketSnapshot.lastPrice,
          marketSnapshot.amount24,
          this.serializeDailyAmounts(nextDailyAmounts.values),
          nextDailyAmounts.utcDate,
          updatedAt,
          this.nextMaximum(card.buy_price_safe, card.buy_price_safe_max_observed, marketSnapshot.lastPrice),
          this.nextMaximum(card.buy_price_risk, card.buy_price_risk_max_observed, marketSnapshot.lastPrice),
          this.nextMinimum(card.sell_price, card.sell_price_min_observed, marketSnapshot.lastPrice),
          card.id
        )

        if (thresholdsToInsert.length > 0) {
          this.insertRatioThresholdEvents(card.symbol, thresholdsToInsert, updatedAt)
        }

        if (priceLevelEventsToInsert.length > 0) {
          this.insertPriceLevelEvents(card, priceLevelEventsToInsert, marketSnapshot.lastPrice, updatedAt)
        }
      }

      this.deleteExpiredRatioThresholdEvents(updatedAt)
      this.deleteExpiredPriceLevelEvents(updatedAt)
    })
  }

  getById(id: number): StoredCard | null {
    const statement = this.db.prepare(`
      SELECT id, symbol, buy_price_safe, buy_price_risk, sell_price, buy_price_safe_max_observed, buy_price_risk_max_observed, sell_price_min_observed, created_at, mexc_price, mexc_amount_24h, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date, mexc_price_updated_at, mexc_sync_status
      FROM cards
      WHERE id = ?
    `)
    const row = statement.get(id) as CardRow | undefined

    return row ? this.mapCardRow(row) : null
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY,
        symbol TEXT NOT NULL,
        buy_price_safe REAL NULL,
        buy_price_risk REAL NULL,
        sell_price REAL NULL,
        buy_price_safe_max_observed REAL NULL,
        buy_price_risk_max_observed REAL NULL,
        sell_price_min_observed REAL NULL,
        created_at TEXT NOT NULL,
        mexc_price REAL NULL,
        mexc_amount_24h REAL NULL,
        mexc_daily_amounts_3m TEXT NULL,
        mexc_daily_amounts_utc_date TEXT NULL,
        mexc_price_updated_at TEXT NULL,
        mexc_sync_status TEXT NOT NULL DEFAULT 'pending'
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ratio_threshold_events (
        id INTEGER PRIMARY KEY,
        symbol TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        event_at TEXT NOT NULL,
        crossed_threshold_count INTEGER NOT NULL
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_subscribers (
        chat_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NULL,
        first_name TEXT NULL,
        min_threshold INTEGER NOT NULL DEFAULT 2,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_notified_event_id INTEGER NULL,
        last_notified_price_event_id INTEGER NULL
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_level_events (
        id INTEGER PRIMARY KEY,
        card_id INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        trigger_price REAL NOT NULL,
        market_price REAL NOT NULL,
        event_at TEXT NOT NULL
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    const columns = this.readTableColumns('cards')
    const telegramSubscriberColumns = this.readTableColumns('telegram_subscribers')

    if (columns.has('price')) {
      this.rebuildCardsSchema(columns)
      this.initializeSchema()
      return
    }

    if (this.needsRelaxedBuyPriceSafeConstraint(columns)) {
      this.rebuildCardsSchema(columns)
      this.initializeSchema()
      return
    }

    if (!columns.has('mexc_price')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN mexc_price REAL NULL')
    }

    if (!columns.has('mexc_amount_24h')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN mexc_amount_24h REAL NULL')
      this.backfillMexcAmount24hFromDailyAmounts()
    }

    if (!columns.has('mexc_daily_amounts_3m')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN mexc_daily_amounts_3m TEXT NULL')
    }

    if (!columns.has('mexc_daily_amounts_utc_date')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN mexc_daily_amounts_utc_date TEXT NULL')
      this.reverseStoredDailyAmountsForNewestFirstOrder()
    }

    if (!columns.has('mexc_price_updated_at')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN mexc_price_updated_at TEXT NULL')
    }

    if (!columns.has('mexc_sync_status')) {
      this.db.exec("ALTER TABLE cards ADD COLUMN mexc_sync_status TEXT NOT NULL DEFAULT 'pending'")
    }

    if (!columns.has('buy_price_safe')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN buy_price_safe REAL NULL')
    }

    if (!columns.has('buy_price_risk')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN buy_price_risk REAL NULL')
    }

    if (!columns.has('sell_price')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN sell_price REAL NULL')
    }

    if (!columns.has('buy_price_safe_max_observed')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN buy_price_safe_max_observed REAL NULL')
      this.db.exec('UPDATE cards SET buy_price_safe_max_observed = buy_price_safe')
    }

    if (!columns.has('buy_price_risk_max_observed')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN buy_price_risk_max_observed REAL NULL')
      this.db.exec('UPDATE cards SET buy_price_risk_max_observed = buy_price_risk')
    }

    if (!columns.has('sell_price_min_observed')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN sell_price_min_observed REAL NULL')
      this.db.exec('UPDATE cards SET sell_price_min_observed = sell_price')
    }

    if (!telegramSubscriberColumns.has('last_notified_price_event_id')) {
      this.db.exec('ALTER TABLE telegram_subscribers ADD COLUMN last_notified_price_event_id INTEGER NULL')
    }

    this.db.exec(`
      UPDATE cards
      SET mexc_sync_status = 'pending'
      WHERE mexc_sync_status IS NULL OR mexc_sync_status = ''
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cards_symbol ON cards (symbol);
      CREATE INDEX IF NOT EXISTS idx_cards_created_at_id ON cards (created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_cards_mexc_sync_status ON cards (mexc_sync_status);
      CREATE INDEX IF NOT EXISTS idx_ratio_threshold_events_event_at ON ratio_threshold_events (event_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_ratio_threshold_events_threshold_event_at ON ratio_threshold_events (threshold, event_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_ratio_threshold_events_symbol_event_at ON ratio_threshold_events (symbol, event_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_price_level_events_event_at ON price_level_events (event_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_price_level_events_card_kind_day ON price_level_events (card_id, kind, direction, event_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_is_active ON telegram_subscribers (is_active, chat_id);
    `)
  }

  private configureDatabase(): void {
    this.db.exec('PRAGMA busy_timeout = 5000')

    if (this.usesFileDatabase) {
      this.db.exec('PRAGMA journal_mode = WAL')
    }
  }

  private readTableColumns(tableName: string): Map<string, ColumnInfoRow> {
    const columnInfo = this.db.prepare(`PRAGMA table_info(${tableName})`)
    const rows = columnInfo.all() as unknown as ColumnInfoRow[]

    return new Map(rows.map((column) => [column.name, column]))
  }

  private needsRelaxedBuyPriceSafeConstraint(columns: Map<string, ColumnInfoRow>): boolean {
    const buyPriceSafe = columns.get('buy_price_safe')

    return buyPriceSafe?.notnull === 1
  }

  private rebuildCardsSchema(columns: Map<string, ColumnInfoRow>): void {
    const buyPriceSafeSelect = columns.has('buy_price_safe')
      ? 'buy_price_safe'
      : columns.has('price')
        ? 'price'
        : 'NULL'
    const buyPriceRiskSelect = columns.has('buy_price_risk') ? 'buy_price_risk' : 'NULL'
    const sellPriceSelect = columns.has('sell_price') ? 'sell_price' : 'NULL'
    const buyPriceSafeMaxObservedSelect = columns.has('buy_price_safe_max_observed')
      ? 'buy_price_safe_max_observed'
      : buyPriceSafeSelect
    const buyPriceRiskMaxObservedSelect = columns.has('buy_price_risk_max_observed')
      ? 'buy_price_risk_max_observed'
      : buyPriceRiskSelect
    const sellPriceMinObservedSelect = columns.has('sell_price_min_observed')
      ? 'sell_price_min_observed'
      : sellPriceSelect
    const mexcPriceSelect = columns.has('mexc_price') ? 'mexc_price' : 'NULL'
    const mexcAmount24hSelect = columns.has('mexc_amount_24h') ? 'mexc_amount_24h' : 'NULL'
    const mexcDailyAmounts3mSelect = columns.has('mexc_daily_amounts_3m') ? 'mexc_daily_amounts_3m' : 'NULL'
    const mexcDailyAmountsUtcDateSelect = columns.has('mexc_daily_amounts_utc_date') ? 'mexc_daily_amounts_utc_date' : 'NULL'
    const mexcPriceUpdatedAtSelect = columns.has('mexc_price_updated_at') ? 'mexc_price_updated_at' : 'NULL'
    const mexcSyncStatusSelect = columns.has('mexc_sync_status')
      ? "COALESCE(NULLIF(mexc_sync_status, ''), 'pending')"
      : "'pending'"

    this.db.exec(`
      BEGIN TRANSACTION;

      ALTER TABLE cards RENAME TO cards_legacy;

      CREATE TABLE cards (
        id INTEGER PRIMARY KEY,
        symbol TEXT NOT NULL,
        buy_price_safe REAL NULL,
        buy_price_risk REAL NULL,
        sell_price REAL NULL,
        buy_price_safe_max_observed REAL NULL,
        buy_price_risk_max_observed REAL NULL,
        sell_price_min_observed REAL NULL,
        created_at TEXT NOT NULL,
        mexc_price REAL NULL,
        mexc_amount_24h REAL NULL,
        mexc_daily_amounts_3m TEXT NULL,
        mexc_daily_amounts_utc_date TEXT NULL,
        mexc_price_updated_at TEXT NULL,
        mexc_sync_status TEXT NOT NULL DEFAULT 'pending'
      );

      INSERT INTO cards (
        id,
        symbol,
        buy_price_safe,
        buy_price_risk,
        sell_price,
        buy_price_safe_max_observed,
        buy_price_risk_max_observed,
        sell_price_min_observed,
        created_at,
        mexc_price,
        mexc_amount_24h,
        mexc_daily_amounts_3m,
        mexc_daily_amounts_utc_date,
        mexc_price_updated_at,
        mexc_sync_status
      )
      SELECT
        id,
        symbol,
        ${buyPriceSafeSelect},
        ${buyPriceRiskSelect},
        ${sellPriceSelect},
        ${buyPriceSafeMaxObservedSelect},
        ${buyPriceRiskMaxObservedSelect},
        ${sellPriceMinObservedSelect},
        created_at,
        ${mexcPriceSelect},
        ${mexcAmount24hSelect},
        ${mexcDailyAmounts3mSelect},
        ${mexcDailyAmountsUtcDateSelect},
        ${mexcPriceUpdatedAtSelect},
        ${mexcSyncStatusSelect}
      FROM cards_legacy;

      DROP TABLE cards_legacy;

      COMMIT;
    `)
  }

  private mapCardRow(row: CardRow): StoredCard {
    return {
      id: row.id,
      symbol: row.symbol,
      buyPriceSafe: row.buy_price_safe,
      buyPriceRisk: row.buy_price_risk,
      sellPrice: row.sell_price,
      buyPriceSafeMaxObserved: row.buy_price_safe_max_observed,
      buyPriceRiskMaxObserved: row.buy_price_risk_max_observed,
      sellPriceMinObserved: row.sell_price_min_observed,
      createdAt: row.created_at,
      mexcPrice: row.mexc_price,
      mexcAmount24h: row.mexc_amount_24h,
      mexcDailyAmounts3m: this.parseDailyAmounts(row.mexc_daily_amounts_3m),
      mexcDailyAmountsUtcDate: row.mexc_daily_amounts_utc_date,
      mexcPriceUpdatedAt: row.mexc_price_updated_at,
      mexcSyncStatus: row.mexc_sync_status
    }
  }

  private mapTelegramSubscriberRow(row: TelegramSubscriberRow): TelegramSubscriber {
    return {
      chatId: row.chat_id,
      userId: row.user_id,
      username: row.username,
      firstName: row.first_name,
      minThreshold: row.min_threshold,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastNotifiedEventId: row.last_notified_event_id,
      lastNotifiedPriceEventId: row.last_notified_price_event_id
    }
  }

  private mapPriceLevelEventRow(row: PriceLevelEventRow): PriceLevelEvent {
    return {
      id: row.id,
      cardId: row.card_id,
      symbol: row.symbol,
      kind: row.kind,
      direction: row.direction,
      triggerPrice: row.trigger_price,
      marketPrice: row.market_price,
      eventAt: row.event_at
    }
  }

  private getCardsForMexcSync(symbol?: string): MexcSyncCardRow[] {
    if (symbol) {
      const statement = this.db.prepare(`
        SELECT id, symbol, buy_price_safe, buy_price_risk, sell_price, buy_price_safe_max_observed, buy_price_risk_max_observed, sell_price_min_observed, mexc_price, mexc_amount_24h, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date
        FROM cards
        WHERE symbol = ?
      `)

      return statement.all(symbol) as unknown as MexcSyncCardRow[]
    }

    const statement = this.db.prepare(`
      SELECT id, symbol, buy_price_safe, buy_price_risk, sell_price, buy_price_safe_max_observed, buy_price_risk_max_observed, sell_price_min_observed, mexc_price, mexc_amount_24h, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date
      FROM cards
    `)

    return statement.all() as unknown as MexcSyncCardRow[]
  }

  private applySyncedMexcRows(
    cards: MexcSyncCardRow[],
    mexcPrice: number,
    updatedAt: string,
    options?: { amount24?: number | null; utcDate?: string }
  ): void {
    const statement = this.db.prepare(`
      UPDATE cards
      SET mexc_price = ?, mexc_amount_24h = ?, mexc_daily_amounts_3m = ?, mexc_daily_amounts_utc_date = ?, mexc_price_updated_at = ?, mexc_sync_status = 'synced', buy_price_safe_max_observed = ?, buy_price_risk_max_observed = ?, sell_price_min_observed = ?
      WHERE id = ?
    `)

    for (const card of cards) {
      const nextDailyAmounts =
        options?.utcDate && typeof options.amount24 === 'number'
          ? this.rollDailyAmounts(
              this.parseDailyAmounts(card.mexc_daily_amounts_3m),
              card.mexc_daily_amounts_utc_date,
              options.amount24,
              options.utcDate
            )
          : {
              values: this.parseDailyAmounts(card.mexc_daily_amounts_3m),
              utcDate: card.mexc_daily_amounts_utc_date
            }

      statement.run(
        mexcPrice,
        options?.amount24 ?? null,
        this.serializeDailyAmounts(nextDailyAmounts.values),
        nextDailyAmounts.utcDate,
        updatedAt,
        this.nextMaximum(card.buy_price_safe, card.buy_price_safe_max_observed, mexcPrice),
        this.nextMaximum(card.buy_price_risk, card.buy_price_risk_max_observed, mexcPrice),
        this.nextMinimum(card.sell_price, card.sell_price_min_observed, mexcPrice),
        card.id
      )
    }
  }

  private insertRatioThresholdEvents(symbol: string, thresholds: number[], eventAt: string): void {
    const statement = this.db.prepare(`
      INSERT INTO ratio_threshold_events (symbol, threshold, event_at, crossed_threshold_count)
      VALUES (?, ?, ?, ?)
    `)
    const crossedThresholdCount = thresholds.length

    for (const threshold of thresholds) {
      statement.run(symbol, threshold, eventAt, crossedThresholdCount)
    }
  }

  private insertPriceLevelEvents(
    card: MexcSyncCardRow,
    events: Array<{ kind: PriceLevelEventKind; direction: PriceLevelEventDirection; triggerPrice: number }>,
    marketPrice: number,
    eventAt: string
  ): void {
    const statement = this.db.prepare(`
      INSERT INTO price_level_events (card_id, symbol, kind, direction, trigger_price, market_price, event_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    for (const event of events) {
      statement.run(card.id, card.symbol, event.kind, event.direction, event.triggerPrice, marketPrice, eventAt)
    }
  }

  private insertPriceLevelEventsForCard(
    card: MexcSyncCardRow,
    marketPrice: number,
    eventAt: string,
    utcDate: string
  ): void {
    const events = this.detectPriceLevelEvents(card, marketPrice, utcDate)

    if (events.length > 0) {
      this.insertPriceLevelEvents(card, events, marketPrice, eventAt)
    }
  }

  private deleteExpiredRatioThresholdEvents(referenceTimestamp: string): void {
    const cutoffDate = new Date(referenceTimestamp)
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - RATIO_EVENT_RETENTION_DAYS)

    this.db
      .prepare(`
        DELETE FROM ratio_threshold_events
        WHERE event_at < ?
      `)
      .run(cutoffDate.toISOString())
  }

  private deleteExpiredPriceLevelEvents(referenceTimestamp: string): void {
    const cutoffDate = new Date(referenceTimestamp)
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - PRICE_LEVEL_EVENT_RETENTION_DAYS)

    this.db
      .prepare(`
        DELETE FROM price_level_events
        WHERE event_at < ?
      `)
      .run(cutoffDate.toISOString())
  }

  private getLatestCompletedDailyAmount(dailyAmounts: number[] | null): number | null {
    const latestCompletedDailyAmount = dailyAmounts?.[0]

    return typeof latestCompletedDailyAmount === 'number' && Number.isFinite(latestCompletedDailyAmount)
      ? latestCompletedDailyAmount
      : null
  }

  private calculateRatio(amount24: number | null, dailyAmounts: number[] | null): number | null {
    if (typeof amount24 !== 'number' || !Number.isFinite(amount24)) {
      return null
    }

    const average = calculateRobustAverage(dailyAmounts ?? [])

    if (average === null || average <= 0) {
      return null
    }

    return amount24 / average
  }

  private detectCrossedThresholds(previousRatio: number | null, nextRatio: number | null): number[] {
    if (previousRatio === null || nextRatio === null) {
      return []
    }

    return RATIO_EVENT_THRESHOLDS.filter((threshold) => previousRatio <= threshold && nextRatio > threshold)
  }

  private filterThresholdsByPreviousDayVolume(
    thresholds: number[],
    amount24: number | null,
    latestCompletedDailyAmount: number | null
  ): number[] {
    if (typeof amount24 !== 'number' || !Number.isFinite(amount24)) {
      return []
    }

    if (
      typeof latestCompletedDailyAmount !== 'number' ||
      !Number.isFinite(latestCompletedDailyAmount) ||
      latestCompletedDailyAmount <= 0
    ) {
      return []
    }

    return amount24 >= latestCompletedDailyAmount * 2 ? thresholds : []
  }

  private detectPriceLevelEvents(
    card: MexcSyncCardRow,
    nextPrice: number,
    utcDate: string
  ): Array<{ kind: PriceLevelEventKind; direction: PriceLevelEventDirection; triggerPrice: number }> {
    const previousPrice = card.mexc_price

    if (typeof previousPrice !== 'number' || !Number.isFinite(previousPrice)) {
      return []
    }

    const candidates = [
      {
        kind: 'buyPriceSafe' as const,
        direction: 'up' as const,
        triggerPrice: card.buy_price_safe
      },
      {
        kind: 'buyPriceRisk' as const,
        direction: 'up' as const,
        triggerPrice: card.buy_price_risk
      },
      {
        kind: 'sellPrice' as const,
        direction: 'down' as const,
        triggerPrice: card.sell_price
      }
    ]

    const events: Array<{
      kind: PriceLevelEventKind
      direction: PriceLevelEventDirection
      triggerPrice: number
    }> = []

    for (const candidate of candidates) {
      if (typeof candidate.triggerPrice !== 'number' || !Number.isFinite(candidate.triggerPrice)) {
        continue
      }

      const crossed =
        candidate.direction === 'up'
          ? previousPrice < candidate.triggerPrice && nextPrice >= candidate.triggerPrice
          : previousPrice > candidate.triggerPrice && nextPrice <= candidate.triggerPrice

      if (
        crossed &&
        !this.hasPriceLevelEventForUtcDay(card.id, candidate.kind, candidate.direction, utcDate)
      ) {
        events.push({
          kind: candidate.kind,
          direction: candidate.direction,
          triggerPrice: candidate.triggerPrice
        })
      }
    }

    return events
  }

  private filterLoggedThresholdsForUtcDay(symbol: string, thresholds: number[], utcDate: string): number[] {
    if (thresholds.length === 0) {
      return thresholds
    }

    const dayStart = new Date(`${utcDate}T00:00:00.000Z`)
    const nextDayStart = new Date(dayStart)
    nextDayStart.setUTCDate(nextDayStart.getUTCDate() + 1)
    const statement = this.db.prepare(`
      SELECT 1
      FROM ratio_threshold_events
      WHERE symbol = ? AND threshold = ? AND event_at >= ? AND event_at < ?
      LIMIT 1
    `)

    return thresholds.filter(
      (threshold) =>
        statement.get(symbol, threshold, dayStart.toISOString(), nextDayStart.toISOString()) === undefined
    )
  }

  private hasPriceLevelEventForUtcDay(
    cardId: number,
    kind: PriceLevelEventKind,
    direction: PriceLevelEventDirection,
    utcDate: string
  ): boolean {
    const dayStart = new Date(`${utcDate}T00:00:00.000Z`)
    const nextDayStart = new Date(dayStart)
    nextDayStart.setUTCDate(nextDayStart.getUTCDate() + 1)
    const row = this.db
      .prepare(`
        SELECT 1
        FROM price_level_events
        WHERE card_id = ? AND kind = ? AND direction = ? AND event_at >= ? AND event_at < ?
        LIMIT 1
      `)
      .get(cardId, kind, direction, dayStart.toISOString(), nextDayStart.toISOString())

    return row !== undefined
  }

  private withTransaction<T>(callback: () => T): T {
    this.db.exec('BEGIN')

    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private reverseStoredDailyAmountsForNewestFirstOrder(): void {
    const rows = this.db.prepare(`
      SELECT id, mexc_daily_amounts_3m
      FROM cards
      WHERE mexc_daily_amounts_3m IS NOT NULL
    `)
    const update = this.db.prepare(`
      UPDATE cards
      SET mexc_daily_amounts_3m = ?, mexc_daily_amounts_utc_date = NULL
      WHERE id = ?
    `)

    for (const row of rows.all() as Array<{ id: number; mexc_daily_amounts_3m: string | null }>) {
      const values = this.parseDailyAmounts(row.mexc_daily_amounts_3m)

      if (values === null) {
        continue
      }

      update.run(this.serializeDailyAmounts([...values].reverse()), row.id)
    }
  }

  private backfillMexcAmount24hFromDailyAmounts(): void {
    const rows = this.db.prepare(`
      SELECT id, mexc_daily_amounts_3m
      FROM cards
      WHERE mexc_amount_24h IS NULL AND mexc_daily_amounts_3m IS NOT NULL
    `)
    const update = this.db.prepare(`
      UPDATE cards
      SET mexc_amount_24h = ?
      WHERE id = ?
    `)

    for (const row of rows.all() as Array<{ id: number; mexc_daily_amounts_3m: string | null }>) {
      const firstAmount = this.parseDailyAmounts(row.mexc_daily_amounts_3m)?.[0]

      if (typeof firstAmount !== 'number') {
        continue
      }

      update.run(firstAmount, row.id)
    }
  }

  private rollDailyAmounts(
    currentValues: number[] | null,
    currentUtcDate: string | null,
    amount24: number,
    utcDate: string
  ): { values: number[] | null; utcDate: string | null } {
    if (currentValues === null) {
      return {
        values: null,
        utcDate: currentUtcDate
      }
    }

    if (currentUtcDate === utcDate) {
      return {
        values: currentValues,
        utcDate: currentUtcDate
      }
    }

    return {
      values: [amount24, ...currentValues].slice(0, 90),
      utcDate
    }
  }

  private nextMaximum(level: number | null, currentMaximum: number | null, marketPrice: number): number | null {
    if (level === null) {
      return null
    }

    return Math.max(level, currentMaximum ?? level, marketPrice)
  }

  private nextMinimum(level: number | null, currentMinimum: number | null, marketPrice: number): number | null {
    if (level === null) {
      return null
    }

    return Math.min(level, currentMinimum ?? level, marketPrice)
  }

  private serializeDailyAmounts(values: number[] | null): string | null {
    return values === null ? null : JSON.stringify(values)
  }

  private parseDailyAmounts(value: string | null): number[] | null {
    if (value === null) {
      return null
    }

    try {
      const parsed = JSON.parse(value) as unknown

      if (!Array.isArray(parsed)) {
        return null
      }

      const amounts = parsed.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))

      return amounts.length === parsed.length ? amounts : null
    } catch {
      return null
    }
  }
}
