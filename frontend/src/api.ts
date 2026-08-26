import type {
  Card,
  CardPayload,
  PriceSignalStatistic,
  RatioThresholdEvent,
} from './types'

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)

  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(input, {
    headers,
    ...init
  })

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(errorBody?.message ?? 'Request failed')
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

export const cardsApi = {
  list() {
    return request<Card[]>('/api/cards')
  },
  create(payload: CardPayload) {
    return request<Card>('/api/cards', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
  },
  update(id: number, payload: CardPayload) {
    return request<Card>(`/api/cards/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    })
  },
  remove(id: number) {
    return request<void>(`/api/cards/${id}`, {
      method: 'DELETE'
    })
  }
}

export const ratioThresholdEventsApi = {
  list(threshold: number) {
    return request<RatioThresholdEvent[]>(`/api/ratio-threshold-events?threshold=${threshold}`)
  }
}

export const priceSignalStatisticsApi = {
  list() {
    return request<PriceSignalStatistic[]>('/api/price-signal-statistics')
  },
}
