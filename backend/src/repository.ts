import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Card, CardPayload, MexcSyncStatus } from './types.js'

interface CardRow {
  id: number
  symbol: string
  price: number
  created_at: string
  mexc_price: number | null
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

  list(): Card[] {
    const statement = this.db.prepare(`
      SELECT id, symbol, price, created_at, mexc_price, mexc_price_updated_at, mexc_sync_status
      FROM cards
      ORDER BY datetime(created_at) DESC, id DESC
    `)

    return (statement.all() as unknown as CardRow[]).map((row) => this.mapCardRow(row))
  }

  create(payload: CardPayload): Card {
    const createdAt = new Date().toISOString()
    const statement = this.db.prepare(`
      INSERT INTO cards (symbol, price, created_at)
      VALUES (?, ?, ?)
    `)
    const result = statement.run(payload.symbol, payload.price, createdAt)
    const id = Number(result.lastInsertRowid)

    return {
      id,
      symbol: payload.symbol,
      price: payload.price,
      createdAt,
      mexcPrice: null,
      mexcPriceUpdatedAt: null,
      mexcSyncStatus: 'pending'
    }
  }

  update(id: number, payload: CardPayload): Card | null {
    const existing = this.findById(id)

    if (!existing) {
      return null
    }

    const symbolChanged = existing.symbol !== payload.symbol

    const statement = this.db.prepare(`
      UPDATE cards
      SET symbol = ?, price = ?, mexc_price = ?, mexc_price_updated_at = ?, mexc_sync_status = ?
      WHERE id = ?
    `)

    statement.run(
      payload.symbol,
      payload.price,
      symbolChanged ? null : existing.mexcPrice,
      symbolChanged ? null : existing.mexcPriceUpdatedAt,
      symbolChanged ? 'pending' : existing.mexcSyncStatus,
      id
    )

    return {
      ...existing,
      symbol: payload.symbol,
      price: payload.price,
      mexcPrice: symbolChanged ? null : existing.mexcPrice,
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

  private findById(id: number): Card | null {
    const statement = this.db.prepare(`
      SELECT id, symbol, price, created_at, mexc_price, mexc_price_updated_at, mexc_sync_status
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
        price REAL NOT NULL,
        created_at TEXT NOT NULL,
        mexc_price REAL NULL,
        mexc_price_updated_at TEXT NULL,
        mexc_sync_status TEXT NOT NULL DEFAULT 'pending'
      )
    `)

    const columnInfo = this.db.prepare('PRAGMA table_info(cards)')
    const columns = new Set(
      (columnInfo.all() as unknown as Array<{ name: string }>).map((column) => column.name)
    )

    if (!columns.has('mexc_price')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN mexc_price REAL NULL')
    }

    if (!columns.has('mexc_price_updated_at')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN mexc_price_updated_at TEXT NULL')
    }

    if (!columns.has('mexc_sync_status')) {
      this.db.exec("ALTER TABLE cards ADD COLUMN mexc_sync_status TEXT NOT NULL DEFAULT 'pending'")
    }

    this.db.exec(`
      UPDATE cards
      SET mexc_sync_status = 'pending'
      WHERE mexc_sync_status IS NULL OR mexc_sync_status = ''
    `)
  }

  private mapCardRow(row: CardRow): Card {
    return {
      id: row.id,
      symbol: row.symbol,
      price: row.price,
      createdAt: row.created_at,
      mexcPrice: row.mexc_price,
      mexcPriceUpdatedAt: row.mexc_price_updated_at,
      mexcSyncStatus: row.mexc_sync_status
    }
  }
}
