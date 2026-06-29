import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { CardPayload, MexcSyncStatus, StoredCard } from './types.js'

interface CardRow {
  id: number
  symbol: string
  buy_price_safe: number | null
  buy_price_risk: number | null
  sell_price: number | null
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
  mexc_daily_amounts_3m: string | null
  mexc_daily_amounts_utc_date: string | null
}

interface ColumnInfoRow {
  name: string
  notnull: number
}

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
      SELECT id, symbol, buy_price_safe, buy_price_risk, sell_price, created_at, mexc_price, mexc_amount_24h, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date, mexc_price_updated_at, mexc_sync_status
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
      INSERT INTO cards (symbol, buy_price_safe, buy_price_risk, sell_price, created_at, mexc_amount_24h, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = statement.run(
      payload.symbol,
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
      SET symbol = ?, buy_price_safe = ?, buy_price_risk = ?, sell_price = ?, mexc_price = ?, mexc_amount_24h = ?, mexc_daily_amounts_3m = ?, mexc_daily_amounts_utc_date = ?, mexc_price_updated_at = ?, mexc_sync_status = ?
      WHERE id = ?
    `)

    statement.run(
      payload.symbol,
      payload.buyPriceSafe,
      payload.buyPriceRisk,
      payload.sellPrice,
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
        SET mexc_price = ?, mexc_amount_24h = ?, mexc_daily_amounts_3m = ?, mexc_daily_amounts_utc_date = ?, mexc_price_updated_at = ?, mexc_sync_status = 'synced'
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

        const nextDailyAmounts =
          typeof marketSnapshot.amount24 === 'number'
            ? this.rollDailyAmounts(
                this.parseDailyAmounts(card.mexc_daily_amounts_3m),
                card.mexc_daily_amounts_utc_date,
                marketSnapshot.amount24,
                utcDate
              )
            : {
                values: this.parseDailyAmounts(card.mexc_daily_amounts_3m),
                utcDate: card.mexc_daily_amounts_utc_date
              }

        updateSyncedStatement.run(
          marketSnapshot.lastPrice,
          marketSnapshot.amount24,
          this.serializeDailyAmounts(nextDailyAmounts.values),
          nextDailyAmounts.utcDate,
          updatedAt,
          card.id
        )
      }
    })
  }

  getById(id: number): StoredCard | null {
    const statement = this.db.prepare(`
      SELECT id, symbol, buy_price_safe, buy_price_risk, sell_price, created_at, mexc_price, mexc_amount_24h, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date, mexc_price_updated_at, mexc_sync_status
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
        created_at TEXT NOT NULL,
        mexc_price REAL NULL,
        mexc_amount_24h REAL NULL,
        mexc_daily_amounts_3m TEXT NULL,
        mexc_daily_amounts_utc_date TEXT NULL,
        mexc_price_updated_at TEXT NULL,
        mexc_sync_status TEXT NOT NULL DEFAULT 'pending'
      )
    `)

    const columns = this.readColumns()

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

    this.db.exec(`
      UPDATE cards
      SET mexc_sync_status = 'pending'
      WHERE mexc_sync_status IS NULL OR mexc_sync_status = ''
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cards_symbol ON cards (symbol);
      CREATE INDEX IF NOT EXISTS idx_cards_created_at_id ON cards (created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_cards_mexc_sync_status ON cards (mexc_sync_status);
    `)
  }

  private configureDatabase(): void {
    this.db.exec('PRAGMA busy_timeout = 5000')

    if (this.usesFileDatabase) {
      this.db.exec('PRAGMA journal_mode = WAL')
    }
  }

  private readColumns(): Map<string, ColumnInfoRow> {
    const columnInfo = this.db.prepare('PRAGMA table_info(cards)')
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
      createdAt: row.created_at,
      mexcPrice: row.mexc_price,
      mexcAmount24h: row.mexc_amount_24h,
      mexcDailyAmounts3m: this.parseDailyAmounts(row.mexc_daily_amounts_3m),
      mexcDailyAmountsUtcDate: row.mexc_daily_amounts_utc_date,
      mexcPriceUpdatedAt: row.mexc_price_updated_at,
      mexcSyncStatus: row.mexc_sync_status
    }
  }

  private getCardsForMexcSync(symbol?: string): MexcSyncCardRow[] {
    if (symbol) {
      const statement = this.db.prepare(`
        SELECT id, symbol, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date
        FROM cards
        WHERE symbol = ?
      `)

      return statement.all(symbol) as unknown as MexcSyncCardRow[]
    }

    const statement = this.db.prepare(`
      SELECT id, symbol, mexc_daily_amounts_3m, mexc_daily_amounts_utc_date
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
      SET mexc_price = ?, mexc_amount_24h = ?, mexc_daily_amounts_3m = ?, mexc_daily_amounts_utc_date = ?, mexc_price_updated_at = ?, mexc_sync_status = 'synced'
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
        card.id
      )
    }
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
