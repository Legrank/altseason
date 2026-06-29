# MEXC Integration Rules

## Single entry point

All backend communication with MEXC must go through `backend/src/integrations/mexc/`.

- `MexcClient` owns the MEXC base URL, endpoint paths, response parsing, cooldown handling, and `Retry-After` behavior.
- Routes, repositories, schedulers, and any future services must not call `fetch('https://contract.mexc.com/...')` directly.
- The frontend never talks to MEXC directly; it only reads local backend data from `/api/cards`.

This is an architectural rule for the project.

## Endpoint used in v1

Current price sync uses one public MEXC futures endpoint:

- `GET /api/v1/contract/ticker`
- `GET /api/v1/contract/kline/{symbol}?interval=Day1`

Manual futures import also uses:

- `GET /api/v1/contract/detail/country`

The backend fetches the full futures market snapshot, then filters local symbols in memory.
For average daily volume, the backend fetches daily kline data for the exact tracked contract and reads the `amount` series.
The current 24-hour futures volume is stored separately from the 90-day history array.

Saved symbol mapping:

- `BTC` card symbol -> `BTC_USDT` MEXC futures contract
- `ETH` card symbol -> `ETH_USDT` MEXC futures contract

Only exact `*_USDT` perpetual contracts are supported in v1.
The synced value stored in cards is the futures ticker field `lastPrice`.
The stored average daily volume is computed from the last 90 daily `amount` values after excluding anomalously high outliers with an upper `IQR` filter.

## Rate-limit policy

Official MEXC futures REST limits relevant to this project:

- `GET /api/v1/contract/ticker`: `20 requests / 2 seconds`
- `GET /api/v1/contract/kline/{symbol}`: `20 requests / 2 seconds`
- `GET /api/v1/contract/detail`: `1 request / 5 seconds`

`/api/v1/contract/detail/country` is not listed separately in the official futures rate-limit table.
This project therefore treats it conservatively as metadata lookup adjacent to `contract/detail` and must not call it in a tight loop or aggressive retry cycle.

Rules adopted in this project:

- Public MEXC futures API requests are treated as IP-limited.
- Normal sync uses one bulk request every 5 minutes, which keeps request volume intentionally low.
- Public sync paths used on the hot path (`ticker` and `kline`) stay far below the documented `20 / 2s` limit.
- The manual import path (`detail/country`) must stay infrequent because MEXC does not publish a separate limit for it in the futures docs.
- If MEXC returns `429`, the client must stop retrying immediately and respect `Retry-After`.
- If MEXC returns `418`, the client must also respect `Retry-After` and treat the IP as temporarily blocked.
- If `Retry-After` is absent, the client falls back to a defensive cooldown before trying again.

## Sync behavior

- One sync runs immediately when the backend starts.
- After startup, the scheduler runs every 5 minutes.
- Only one sync may run at a time.
- A successful sync updates:
  - `mexcPrice`
  - `mexcAmount24h`
  - `mexcPriceUpdatedAt`
  - `mexcSyncStatus = 'synced'`
- During a successful sync, the backend also evaluates ratio breakouts against thresholds `2..10` and records upward crossing events for the last 30 days only.
- If `${symbol}_USDT` is missing from the MEXC futures snapshot:
  - `mexcPrice = null`
  - `mexcAmount24h = null`
  - `mexcPriceUpdatedAt = null`
  - `mexcSyncStatus = 'not_found'`
- If MEXC fails during sync:
  - existing successful `mexcPrice` is preserved
  - existing successful `mexcPriceUpdatedAt` is preserved
  - cards still in `pending` move to `error`

## Extension rule

If new MEXC futures endpoints are added later, add them only inside `backend/src/integrations/mexc/` and expose normalized methods from that layer instead of raw HTTP responses.
