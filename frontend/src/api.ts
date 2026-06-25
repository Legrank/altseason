import type { Card, CardPayload } from './types'

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      'Content-Type': 'application/json'
    },
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

