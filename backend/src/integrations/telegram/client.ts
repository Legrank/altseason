export interface TelegramChat {
  id: number
  type: string
}

export interface TelegramUser {
  id: number
  username?: string
  first_name?: string
}

export interface TelegramMessage {
  message_id: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramApiResponse<T> {
  ok: boolean
  result: T
  description?: string
}

export class TelegramClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelegramClientError'
  }
}

interface TelegramClientOptions {
  token: string
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export class TelegramClient {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(options: TelegramClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl ?? `https://api.telegram.org/bot${options.token}`
  }

  async deleteWebhook(signal?: AbortSignal): Promise<void> {
    await this.request<true>('deleteWebhook', {
      method: 'POST',
      body: JSON.stringify({ drop_pending_updates: false }),
      signal
    })
  }

  async getUpdates(offset?: number, timeoutSeconds = 30, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.request<TelegramUpdate[]>('getUpdates', {
      method: 'POST',
      body: JSON.stringify({
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message']
      }),
      signal
    })
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.request('sendMessage', {
      method: 'POST',
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      }),
      signal
    })
  }

  private async request<T>(
    method: string,
    init: RequestInit & { signal?: AbortSignal }
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {})
      }
    })

    if (!response.ok) {
      throw new TelegramClientError(`Telegram API responded with HTTP ${response.status} for ${method}.`)
    }

    const payload = (await response.json()) as TelegramApiResponse<T>

    if (!payload.ok) {
      throw new TelegramClientError(payload.description ?? `Telegram API request failed for ${method}.`)
    }

    return payload.result
  }
}
