import type { CardRepository, UsdtContractCardSyncResult } from '../repository.js'

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

export const MEXC_CONTRACT_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_RETRY_INTERVAL_MS = 60 * 60 * 1000

interface FuturesContractProvider {
  getUsdtFuturesContractSymbols(): Promise<string[]>
}

interface MexcContractSyncServiceOptions {
  repository: CardRepository
  mexcClient: FuturesContractProvider
  intervalMs?: number
  retryIntervalMs?: number
  now?: () => Date
  onSyncCompleted?: (result: UsdtContractCardSyncResult) => Promise<void> | void
  logger?: Logger
}

function toBaseSymbol(contractSymbol: string): string | null {
  const normalizedSymbol = contractSymbol.trim().toUpperCase()

  if (!normalizedSymbol.endsWith('_USDT')) {
    return null
  }

  const baseSymbol = normalizedSymbol.slice(0, -'_USDT'.length).trim()
  return baseSymbol || null
}

export class MexcContractSyncService {
  private readonly repository: CardRepository
  private readonly mexcClient: FuturesContractProvider
  private readonly intervalMs: number
  private readonly retryIntervalMs: number
  private readonly now: () => Date
  private readonly onSyncCompleted?: (result: UsdtContractCardSyncResult) => Promise<void> | void
  private readonly logger: Logger
  private timer: NodeJS.Timeout | null = null
  private started = false
  private inProgress = false

  constructor(options: MexcContractSyncServiceOptions) {
    this.repository = options.repository
    this.mexcClient = options.mexcClient
    this.intervalMs = options.intervalMs ?? MEXC_CONTRACT_SYNC_INTERVAL_MS
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
    this.onSyncCompleted = options.onSyncCompleted
    this.logger = options.logger ?? noopLogger
  }

  start(): void {
    if (this.started) {
      return
    }

    this.started = true
    this.schedule(this.getInitialDelayMs())
  }

  stop(): void {
    this.started = false

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async syncNow(): Promise<UsdtContractCardSyncResult | null> {
    if (this.inProgress) {
      return null
    }

    this.inProgress = true

    try {
      const contractSymbols = await this.mexcClient.getUsdtFuturesContractSymbols()
      const baseSymbols = contractSymbols
        .map(toBaseSymbol)
        .filter((symbol): symbol is string => symbol !== null)
      const completedAt = this.now().toISOString()
      const result = this.repository.syncUsdtContractCards(baseSymbols, completedAt)

      this.logger.info(
        {
          contractCount: baseSymbols.length,
          createdCount: result.createdCount,
          deletedCount: result.deletedCount,
          completedAt
        },
        'MEXC contract synchronization completed.'
      )

      try {
        await this.onSyncCompleted?.(result)
      } catch (error) {
        // Follow-up price synchronization must not invalidate a completed catalog sync.
        this.logger.warn(
          { err: error },
          'Post-contract-synchronization price update failed.'
        )
      }

      return result
    } catch (error) {
      this.logger.error({ err: error }, 'MEXC contract synchronization failed.')
      return null
    } finally {
      this.inProgress = false
    }
  }

  private getInitialDelayMs(): number {
    if (this.repository.getTrackedSymbols().length === 0) {
      return 0
    }

    const completedAt = this.repository.getUsdtContractSyncCompletedAt()
    const completedAtMs = completedAt === null ? Number.NaN : Date.parse(completedAt)

    if (!Number.isFinite(completedAtMs)) {
      return 0
    }

    return Math.max(0, completedAtMs + this.intervalMs - this.now().getTime())
  }

  private schedule(delayMs: number): void {
    if (!this.started) {
      return
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.runScheduledSync()
    }, delayMs)
  }

  private async runScheduledSync(): Promise<void> {
    const result = await this.syncNow()

    if (!this.started) {
      return
    }

    this.schedule(result === null ? this.retryIntervalMs : this.intervalMs)
  }
}
