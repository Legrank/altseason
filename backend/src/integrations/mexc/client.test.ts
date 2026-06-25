import assert from 'node:assert/strict'
import test from 'node:test'

import { MexcClient, MexcClientError } from './client.js'

test('parses MEXC futures ticker snapshot into a contract symbol map', async () => {
  const client = new MexcClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          code: 0,
          data: [
            { symbol: 'BTC_USDT', lastPrice: 60000.12 },
            { symbol: 'ETH_USDT', lastPrice: 3000.5 }
          ]
        })
      )
  })

  const prices = await client.getAllUsdtFuturesPrices()

  assert.equal(prices.get('BTC_USDT'), 60000.12)
  assert.equal(prices.get('ETH_USDT'), 3000.5)
})

test('parses MEXC futures daily kline amounts and ignores invalid values', async () => {
  const client = new MexcClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          code: 0,
          data: {
            amount: ['100', 200, 'oops', null, Number.POSITIVE_INFINITY]
          }
        })
      )
  })

  const amounts = await client.getUsdtFuturesDailyAmounts('BTC_USDT')

  assert.deepEqual(amounts, [100, 200])
})

test('rejects invalid MEXC futures daily kline payloads with a parse error', async () => {
  const client = new MexcClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          code: 0,
          data: {}
        })
      )
  })

  await assert.rejects(() => client.getUsdtFuturesDailyAmounts('BTC_USDT'), (error: unknown) => {
    assert.ok(error instanceof MexcClientError)
    assert.equal(error.code, 'parse')
    return true
  })
})

test('enters cooldown after 429 and does not hit fetch again before retry-after expires', async () => {
  let now = 0
  let calls = 0
  const client = new MexcClient({
    now: () => now,
    fetchImpl: async () => {
      calls += 1
      return new Response('', {
        status: 429,
        headers: {
          'Retry-After': '7'
        }
      })
    }
  })

  await assert.rejects(() => client.getAllUsdtFuturesPrices(), (error: unknown) => {
    assert.ok(error instanceof MexcClientError)
    assert.equal(error.code, 'rate_limit')
    assert.equal(error.retryAfterMs, 7000)
    return true
  })

  await assert.rejects(() => client.getAllUsdtFuturesPrices(), (error: unknown) => {
    assert.ok(error instanceof MexcClientError)
    assert.equal(error.code, 'cooldown')
    return true
  })

  assert.equal(calls, 1)

  now = 8000

  await assert.rejects(() => client.getAllUsdtFuturesPrices(), (error: unknown) => {
    assert.ok(error instanceof MexcClientError)
    assert.equal(error.code, 'rate_limit')
    return true
  })

  assert.equal(calls, 2)
})
