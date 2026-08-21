import assert from 'node:assert/strict'
import test from 'node:test'

import { TelegramClient } from './client.js'

test('sends a copy-text inline button with a Telegram message', async () => {
  let requestBody: unknown
  const client = new TelegramClient({
    token: 'test-token',
    baseUrl: 'https://telegram.test',
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))

      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await client.sendMessage('42', 'BTC notification', {
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: 'BTC',
            copy_text: { text: 'BTC' },
          },
        ],
      ],
    },
  })

  assert.deepEqual(requestBody, {
    chat_id: '42',
    text: 'BTC notification',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'BTC',
            copy_text: { text: 'BTC' },
          },
        ],
      ],
    },
  })
})
