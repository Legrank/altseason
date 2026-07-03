import { MexcClientError } from '../integrations/mexc/index.js'
import { CardRepository } from '../repository.js'

interface FuturesPriceProvider {
  getAllUsdtFuturesPrices(): Promise<Map<string, { lastPrice: number; amount24: number | null }>>
}

interface MexcSyncServiceOptions {
  repository: CardRepository
  mexcClient: FuturesPriceProvider
  intervalMs?: number
  now?: () => Date
  onSyncCompleted?: () => Promise<void> | void
}

export class MexcSyncService {
  private readonly repository: CardRepository
  private readonly mexcClient: FuturesPriceProvider
  private readonly intervalMs: number
  private readonly now: () => Date
  private readonly onSyncCompleted?: () => Promise<void> | void
  private timer: NodeJS.Timeout | null = null
  private inProgress = false

  constructor(options: MexcSyncServiceOptions) {
    this.repository = options.repository
    this.mexcClient = options.mexcClient
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000
    this.now = options.now ?? (() => new Date())
    this.onSyncCompleted = options.onSyncCompleted
  }

  start(): void {
    if (this.timer) {
      return
    }

    void this.syncNow()
    this.timer = setInterval(() => {
      void this.syncNow()
    }, this.intervalMs)
  }

  stop(): void {
    if (!this.timer) {
      return
    }

    clearInterval(this.timer)
    this.timer = null
  }

  async syncNow(): Promise<void> {
    if (this.inProgress) {
      return
    }

    const trackedSymbols = this.repository.getTrackedSymbols()

    if (trackedSymbols.length === 0) {
      return
    }

    this.inProgress = true

    try {
      const snapshot = await this.mexcClient.getAllUsdtFuturesPrices()
      const now = this.now()
      const updatedAt = now.toISOString()
      const utcDate = updatedAt.slice(0, 10)
      this.repository.applyMexcSnapshot(snapshot, updatedAt, utcDate)
      try {
        await this.onSyncCompleted?.()
      } catch {
        // Telegram delivery must not affect market sync state.
      }
    } catch (error) {
      if (error instanceof MexcClientError) {
        this.repository.markPendingMexcSyncError()
        return
      }

      this.repository.markPendingMexcSyncError()
    } finally {
      this.inProgress = false
    }
  }
}
