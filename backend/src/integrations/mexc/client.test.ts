import assert from 'node:assert/strict'
import test from 'node:test'

import { MexcClient, MexcClientError } from './client.js'

test('extracts only USDT futures symbols from contract detail payload', async () => {
  const client = new MexcClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          code: 0,
          data: [
            { symbol: 'BTC_USDT', quoteCoin: 'USDT' },
            { symbol: 'ETH_USDT', quoteCoin: 'USDT' },
            { symbol: 'BTC_USD', quoteCoin: 'USD' },
            { symbol: 'SOL_USDT' },
            { symbol: '   ', quoteCoin: 'USDT' }
          ]
        })
      )
  })

  const symbols = await client.getUsdtFuturesContractSymbols()

  assert.deepEqual(symbols, ['BTC_USDT', 'ETH_USDT', 'SOL_USDT'])
})

test('parses MEXC futures ticker snapshot into a contract symbol map', async () => {
  const client = new MexcClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          code: 0,
          data: [
            { symbol: 'BTC_USDT', lastPrice: 60000.12, amount24: '12345.6' },
            { symbol: 'ETH_USDT', lastPrice: 3000.5, amount24: 789.1 }
          ]
        })
      )
  })

  const prices = await client.getAllUsdtFuturesPrices()

  assert.deepEqual(prices.get('BTC_USDT'), { lastPrice: 60000.12, amount24: 12345.6 })
  assert.deepEqual(prices.get('ETH_USDT'), { lastPrice: 3000.5, amount24: 789.1 })
})

test('parses MEXC futures daily kline amounts, ignores invalid values, and returns newest first', async () => {
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

  assert.deepEqual(amounts, [200, 100])
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

test('rate limit error for ticker reports documented 20 requests per 2 seconds limit', async () => {
  const client = new MexcClient({
    fetchImpl: async () => new Response('', { status: 429 })
  })

  await assert.rejects(() => client.getAllUsdtFuturesPrices(), (error: unknown) => {
    assert.ok(error instanceof MexcClientError)
    assert.equal(error.code, 'rate_limit')
    assert.match(error.message, /\/api\/v1\/contract\/ticker/)
    assert.match(error.message, /20 requests \/ 2 seconds/)
    return true
  })
})

test('rate limit error for contract detail country reports closest documented detail limit', async () => {
  const client = new MexcClient({
    fetchImpl: async () => new Response('', { status: 429 })
  })

  await assert.rejects(() => client.getUsdtFuturesContractSymbols(), (error: unknown) => {
    assert.ok(error instanceof MexcClientError)
    assert.equal(error.code, 'rate_limit')
    assert.match(error.message, /\/api\/v1\/contract\/detail\/country/)
    assert.match(error.message, /1 request \/ 5 seconds/)
    return true
  })
})
