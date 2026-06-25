import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { CardPayload, MexcSyncStatus, StoredCard } from './types.js'

interface CardRow {
  id: number
  symbol: string
  buy_price_safe: number
  buy_price_risk: number | null
  sell_price: number | null
  created_at: string
  mexc_price: number | null
  mexc_daily_amounts_3m: string | null
  mexc_price_updated_at: string | null
  mexc_sync_status: MexcSyncStatus
}

export class CardRepository {
  private readonly db: DatabaseSync

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true })
    }

    this.db = new DatabaseSync(databasePath)
    this.initializeSchema()
  }

  list(): StoredCard[] {
    const statement = this.db.prepare(`
      SELECT id, symbol, buy_price_safe, buy_price_risk, sell_price, created_at, mexc_price, mexc_daily_amounts_3m, mexc_price_updated_at, mexc_sync_status
      FROM cards
      ORDER BY datetime(created_at) DESC, id DESC
    `)

    return (statement.all() as unknown as CardRow[]).map((row) => this.mapCardRow(row))
  }

  create(payload: CardPayload, options?: { mexcDailyAmounts3m?: number[] | null }): StoredCard {
    const createdAt = new Date().toISOString()
    const mexcDailyAmounts3m = options?.mexcDailyAmounts3m ?? null
    const statement = this.db.prepare(`
      INSERT INTO cards (symbol, buy_price_safe, buy_price_risk, sell_price, created_at, mexc_daily_amounts_3m)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const result = statement.run(
      payload.symbol,
      payload.buyPriceSafe,
      payload.buyPriceRisk,
      payload.sellPrice,
      createdAt,
      this.serializeDailyAmounts(mexcDailyAmounts3m)
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
      mexcDailyAmounts3m,
      mexcPriceUpdatedAt: null,
      mexcSyncStatus: 'pending'
    }
  }

  update(id: number, payload: CardPayload, options?: { mexcDailyAmounts3m?: number[] | null }): StoredCard | null {
    const existing = this.getById(id)

    if (!existing) {
      return null
    }

    const symbolChanged = existing.symbol !== payload.symbol
    const nextMexcDailyAmounts3m =
      options?.mexcDailyAmounts3m === undefined ? existing.mexcDailyAmounts3m : options.mexcDailyAmounts3m

    const statement = this.db.prepare(`
      UPDATE cards
      SET symbol = ?, buy_price_safe = ?, buy_price_risk = ?, sell_price = ?, mexc_price = ?, mexc_daily_amounts_3m = ?, mexc_price_updated_at = ?, mexc_sync_status = ?
      WHERE id = ?
    `)

    statement.run(
      payload.symbol,
      payload.buyPriceSafe,
      payload.buyPriceRisk,
      payload.sellPrice,
      symbolChanged ? null : existing.mexcPrice,
      this.serializeDailyAmounts(nextMexcDailyAmounts3m),
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
      mexcDailyAmounts3m: nextMexcDailyAmounts3m,
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

  applyMexcPrice(symbol: string, mexcPrice: number, updatedAt: string): void {
    const statement = this.db.prepare(`
      UPDATE cards
      SET mexc_price = ?, mexc_price_updated_at = ?, mexc_sync_status = 'synced'
      WHERE symbol = ?
    `)

    statement.run(mexcPrice, updatedAt, symbol)
  }

  markMexcNotFound(symbol: string): void {
    const statement = this.db.prepare(`
      UPDATE cards
      SET mexc_price = NULL, mexc_price_updated_at = NULL, mexc_sync_status = 'not_found'
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

  getById(id: number): StoredCard | null {
    const statement = this.db.prepare(`
      SELECT id, symbol, buy_price_safe, buy_price_risk, sell_price, created_at, mexc_price, mexc_daily_amounts_3m, mexc_price_updated_at, mexc_sync_status
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
        buy_price_safe REAL NOT NULL,
        buy_price_risk REAL NULL,
        sell_price REAL NULL,
        created_at TEXT NOT NULL,
        mexc_price REAL NULL,
        mexc_daily_amounts_3m TEXT NULL,
        mexc_price_updated_at TEXT NULL,
        mexc_sync_status TEXT NOT NULL DEFAULT 'pending'
      )
    `)

    const columnInfo = this.db.prepare('PRAGMA table_info(cards)')
    const columns = new Set(
      (columnInfo.all() as unknown as Array<{ name: string }>).map((column) => column.name)
    )

    if (columns.has('price')) {
      this.rebuildLegacyPriceSchema(columns)
      return
    }

    if (!columns.has('mexc_price')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN mexc_price REAL NULL')
    }

    if (!columns.has('mexc_daily_amounts_3m')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN mexc_daily_amounts_3m TEXT NULL')
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
  }

  private rebuildLegacyPriceSchema(columns: Set<string>): void {
    const buyPriceSafeSelect = columns.has('buy_price_safe')
      ? 'COALESCE(buy_price_safe, price)'
      : 'price'
    const buyPriceRiskSelect = columns.has('buy_price_risk') ? 'buy_price_risk' : 'NULL'
    const sellPriceSelect = columns.has('sell_price') ? 'sell_price' : 'NULL'
    const mexcPriceSelect = columns.has('mexc_price') ? 'mexc_price' : 'NULL'
    const mexcDailyAmounts3mSelect = columns.has('mexc_daily_amounts_3m') ? 'mexc_daily_amounts_3m' : 'NULL'
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
        buy_price_safe REAL NOT NULL,
        buy_price_risk REAL NULL,
        sell_price REAL NULL,
        created_at TEXT NOT NULL,
        mexc_price REAL NULL,
        mexc_daily_amounts_3m TEXT NULL,
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
        mexc_daily_amounts_3m,
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
        ${mexcDailyAmounts3mSelect},
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
      mexcDailyAmounts3m: this.parseDailyAmounts(row.mexc_daily_amounts_3m),
      mexcPriceUpdatedAt: row.mexc_price_updated_at,
      mexcSyncStatus: row.mexc_sync_status
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
