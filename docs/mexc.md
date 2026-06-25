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

The backend fetches the full futures market snapshot, then filters local symbols in memory.

Saved symbol mapping:

- `BTC` card symbol -> `BTC_USDT` MEXC futures contract
- `ETH` card symbol -> `ETH_USDT` MEXC futures contract

Only exact `*_USDT` perpetual contracts are supported in v1.
The synced value stored in cards is the futures ticker field `lastPrice`.

## Rate-limit policy

Rules adopted in this project:

- Public MEXC futures API requests are treated as IP-limited.
- Normal sync uses one bulk request every 5 minutes, which keeps request volume intentionally low.
- If MEXC returns `429`, the client must stop retrying immediately and respect `Retry-After`.
- If MEXC returns `418`, the client must also respect `Retry-After` and treat the IP as temporarily blocked.
- If `Retry-After` is absent, the client falls back to a defensive cooldown before trying again.

## Sync behavior

- One sync runs immediately when the backend starts.
- After startup, the scheduler runs every 5 minutes.
- Only one sync may run at a time.
- A successful sync updates:
  - `mexcPrice`
  - `mexcPriceUpdatedAt`
  - `mexcSyncStatus = 'synced'`
- If `${symbol}_USDT` is missing from the MEXC futures snapshot:
  - `mexcPrice = null`
  - `mexcPriceUpdatedAt = null`
  - `mexcSyncStatus = 'not_found'`
- If MEXC fails during sync:
  - existing successful `mexcPrice` is preserved
  - existing successful `mexcPriceUpdatedAt` is preserved
  - cards still in `pending` move to `error`

## Extension rule

If new MEXC futures endpoints are added later, add them only inside `backend/src/integrations/mexc/` and expose normalized methods from that layer instead of raw HTTP responses.
