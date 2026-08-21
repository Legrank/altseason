import { MexcClientError } from '../integrations/mexc/index.js'
import { CardRepository } from '../repository.js'

interface Logger {
  info(context: Record<string, unknown>, message: string): void
  warn(context: Record<string, unknown>, message: string): void
  error(context: Record<string, unknown>, message: string): void
}

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {}
}

interface FuturesPriceProvider {
  getAllUsdtFuturesPrices(): Promise<Map<string, { lastPrice: number; amount24: number | null }>>
}

interface MexcSyncServiceOptions {
  repository: CardRepository
  mexcClient: FuturesPriceProvider
  intervalMs?: number
  now?: () => Date
  onSyncCompleted?: () => Promise<void> | void
  logger?: Logger
}

export class MexcSyncService {
  private readonly repository: CardRepository
  private readonly mexcClient: FuturesPriceProvider
  private readonly intervalMs: number
  private readonly now: () => Date
  private readonly onSyncCompleted?: () => Promise<void> | void
  private readonly logger: Logger
  private timer: NodeJS.Timeout | null = null
  private inProgress = false

  constructor(options: MexcSyncServiceOptions) {
    this.repository = options.repository
    this.mexcClient = options.mexcClient
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000
    this.now = options.now ?? (() => new Date())
    this.onSyncCompleted = options.onSyncCompleted
    this.logger = options.logger ?? noopLogger
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

      this.logger.info(
        { trackedSymbolCount: trackedSymbols.length, snapshotSize: snapshot.size, updatedAt },
        'MEXC price synchronization completed.'
      )

      try {
        await this.onSyncCompleted?.()
      } catch (error) {
        // Telegram delivery must not affect market sync state.
        this.logger.warn(
          { err: error },
          'Post-synchronization notification delivery failed.'
        )
      }
    } catch (error) {
      this.logger.error(
        {
          err: error,
          errorCode: error instanceof MexcClientError ? error.code : undefined,
          statusCode: error instanceof MexcClientError ? error.statusCode : undefined,
          retryAfterMs: error instanceof MexcClientError ? error.retryAfterMs : undefined
        },
        'MEXC price synchronization failed.'
      )

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
