# Exchange Listing Rules

Cards track a MEXC USDT perpetual. This integration answers the separate question of **where else
the same coin trades**, and renders it as the "Also listed on" badges on each card.

## Single entry point

All backend communication with a non-MEXC venue must go through `backend/src/integrations/exchanges/`,
and all CoinGecko communication through `backend/src/integrations/coingecko/`.

- Each exchange client owns its base URLs, endpoint paths, payload validation, and market filtering.
- `ExchangeHttpClient` owns the shared transport: a 429/418 response starts a cooldown and later
  calls fail fast instead of retrying, matching the `MexcClient` policy.
- Routes, repositories, schedulers, and scripts must not call an exchange or CoinGecko host directly.
- The frontend never talks to any exchange; it reads `/api/cards`.

This is an architectural rule for the project, same as the MEXC boundary in [mexc.md](mexc.md).

## Two sources, deliberately

| | Direct exchange APIs | CoinGecko |
|---|---|---|
| Cost | One request per market per venue — the whole catalog for well under a dozen calls | One credit per call, 10k/month on the free Demo plan |
| Coverage | Only the venues with a client | Every venue CoinGecko tracks |
| Freshness | Daily, complete | Rotating, several days per full pass |
| Certainty | Authoritative | Depends on resolving a ticker to the right coin |

A venue read directly always outranks the same venue reported by CoinGecko; the aggregator only
ever contributes exchanges no direct client covers. `coin_listings.source` records which won, and
aggregator-only badges render dashed in the UI.

## Endpoints used

Every endpoint below is public and keyless. Spot and USDT-margined perpetuals are both collected.

| Venue | Spot | Futures |
|---|---|---|
| Binance | `GET api.binance.com/api/v3/exchangeInfo?permissions=SPOT` | `GET fapi.binance.com/fapi/v1/exchangeInfo` |
| Bybit | `GET api.bybit.com/v5/market/instruments-info?category=spot` | `…?category=linear` |
| OKX | `GET www.okx.com/api/v5/public/instruments?instType=SPOT` | `…?instType=SWAP` |
| Gate | `GET api.gateio.ws/api/v4/spot/currency_pairs` | `GET api.gateio.ws/api/v4/futures/usdt/contracts` |
| KuCoin | `GET api.kucoin.com/api/v2/symbols` | `GET api-futures.kucoin.com/api/v1/contracts/active` |
| Bitget | `GET api.bitget.com/api/v2/spot/public/symbols` | `GET api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES` |

CoinGecko: `GET /coins/list`, `GET /coins/markets` (4 pages, for market-cap ranking), and
`GET /coins/{id}/tickers` (max 2 pages per coin).

### Geo-blocking

Binance (HTTP 451) and Bybit (HTTP 403) refuse requests from some regions. A blocked venue fails on
its own and the other venues still sync. Set `EXCHANGE_LISTING_DISABLED_EXCHANGES=binance,bybit` to
stop calling a venue the host cannot reach. Check a host with:

```
cd backend && npm run sync:exchange-listings -- /path/to/scratch.sqlite
```

The run prints `syncedExchanges` and `failedExchanges`.

## Per-venue payload quirks that the clients handle

- **OKX swaps** leave `baseCcy` empty; the base comes from `instFamily` (`BTC-USDT` -> `BTC`).
  Inverse contracts are excluded via `settleCcy`/`ctType`.
- **KuCoin futures** use the legacy `XBT` ticker for bitcoin, mapped back to `BTC`.
- **Bitget** echoes the issuer's casing in `baseCoin` (`rPBR`), so base symbols are upper-cased.
- **Bybit linear** includes dated futures; only symbols equal to `{BASE}USDT` are kept.
- Delisted, halted, and untradable instruments are filtered per venue (`status`, `state`,
  `trade_status`, `symbolStatus`, `in_delisting`, `enableTrading`).

## Symbol matching

MEXC lists low-priced assets as scaled perpetuals (`1000BONK`, `1000000MOG`) while other venues use
the unscaled ticker — or their own scale factor. `services/symbol-aliases.ts` expands a symbol into
the symbol itself plus, when a scale prefix is present, the unscaled ticker. **Only the longest
matching prefix is stripped**, otherwise `1000000MOG` would also yield `0MOG`, `00MOG`, `000MOG`.

Both sides of the comparison are expanded, so a `1000BONK` card matches a venue's `BONK` and a `PEPE`
card matches a venue's `1000PEPE`. An exact ticker match always beats one reached through an alias.

This is ticker-level matching, so a collision is possible: a short ticker such as `A`, `GG` or `CAT`
may name a different asset on another venue. Accepted for now; contract-address verification through
`/coins/list?include_platform=true` is the way to tighten it.

## Sync semantics

`ExchangeListingSyncService` — every 24 hours, and once after each MEXC contract catalog sync
(the card set has just changed, so its venue list is stale by definition).

- Each venue is replaced independently inside one transaction, so a failing venue never clears another.
- An empty or non-overlapping venue response is treated as a failure and the previous data is kept —
  a healthy venue always overlaps the MEXC catalog.
- Success is recorded in `app_metadata` only if at least one venue synced, so restarts do not reset
  the interval and a total failure retries in an hour.

`CoingeckoListingSyncService` — every 24 hours, disabled with `COINGECKO_ENABLED=false`.

- Spends `COINGECKO_DAILY_COIN_BUDGET` (default 100) coins per run on the cards whose aggregator data
  is oldest, so the catalog rotates through over several days instead of being fetched at once.
  One card costs one to two calls; the index costs five per run.
- A ticker that maps to exactly one CoinGecko coin resolves directly. An ambiguous ticker is settled
  by market-cap rank. A ticker that is both ambiguous and outside the top ranking is **left
  unresolved rather than guessed**, so a card never shows another coin's venues.
- A rate limit stops the run and leaves the rest of the budget for the next one.
- An empty result is valid here and is stored: it is the correct answer for a coin that trades nowhere
  CoinGecko tracks.

## Storage

`coin_listings` holds one row per `(symbol, exchange, market_type, source)`; `coin_listing_coingecko_state`
holds the rotation cursor and resolved coin id per symbol. Both are pruned when the MEXC contract sync
removes a card. `CardService` collapses the rows into one `CardExchange` per venue, preferring the
direct source and linking to the spot market where one exists.

## Environment variables

- `EXCHANGE_LISTING_DISABLED_EXCHANGES` — comma-separated exchange ids to skip (e.g. geo-blocked venues).
- `COINGECKO_ENABLED` — `false` disables the aggregator sync entirely.
- `COINGECKO_API_KEY` / `COINGECKO_API_KEY_KIND` (`demo` | `pro`) — a Demo key raises the limit to
  100 calls/min and 10k/month. Keyless access is far stricter and will rate-limit a full run.
- `COINGECKO_DAILY_COIN_BUDGET` — cards enriched per run, 1..1000, default 100.
