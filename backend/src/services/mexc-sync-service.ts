import { MexcClientError } from '../integrations/mexc/index.js'
import { CardRepository } from '../repository.js'

interface FuturesPriceProvider {
  getAllUsdtFuturesPrices(): Promise<Map<string, number>>
}

interface MexcSyncServiceOptions {
  repository: CardRepository
  mexcClient: FuturesPriceProvider
  intervalMs?: number
  now?: () => Date
}

export class MexcSyncService {
  private readonly repository: CardRepository
  private readonly mexcClient: FuturesPriceProvider
  private readonly intervalMs: number
  private readonly now: () => Date
  private timer: NodeJS.Timeout | null = null
  private inProgress = false

  constructor(options: MexcSyncServiceOptions) {
    this.repository = options.repository
    this.mexcClient = options.mexcClient
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000
    this.now = options.now ?? (() => new Date())
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
      const updatedAt = this.now().toISOString()

      for (const symbol of trackedSymbols) {
        const marketSymbol = `${symbol}_USDT`
        const mexcPrice = snapshot.get(marketSymbol)

        if (typeof mexcPrice === 'number') {
          this.repository.applyMexcPrice(symbol, mexcPrice, updatedAt)
        } else {
          this.repository.markMexcNotFound(symbol)
        }
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
