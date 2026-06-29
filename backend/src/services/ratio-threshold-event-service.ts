import { CardRepository } from '../repository.js'
import type { RatioThresholdEvent } from '../types.js'

interface RatioThresholdEventServiceOptions {
  repository: CardRepository
}

export class RatioThresholdEventService {
  private readonly repository: CardRepository

  constructor(options: RatioThresholdEventServiceOptions) {
    this.repository = options.repository
  }

  list(threshold: number): RatioThresholdEvent[] {
    return this.repository.listRatioThresholdEvents(threshold)
  }
}
