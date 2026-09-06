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

| | Direct exchange APIs | CoinGecko `/derivatives` |
|---|---|---|
| Markets | Spot and USDT perpetuals | **Perpetuals only** |
| Cost | One request per market per venue — the whole catalog for well under a dozen calls | One call a day, whole universe |
| Coverage | Only the venues with a client | 105 derivatives venues |
| Certainty | Authoritative | CoinGecko resolves the underlying itself, in `index_id` |

A venue read directly always outranks the same venue reported by CoinGecko; the aggregator only
ever contributes exchanges no direct client covers. `coin_listings.source` records which won, and
aggregator-only badges render dashed in the UI.

CoinGecko contributes **no spot data**. Its `/coins/{id}/tickers` endpoint returns spot markets and
nothing else — verified on a live 100-ticker ETH response: every quote is a spot currency and no
entry is a perpetual — but spot is already covered authoritatively by the six direct clients, so
paying per coin for a second opinion buys nothing. Derivatives are the gap, and `/derivatives`
fills it for one credit.

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

CoinGecko: `GET /derivatives` — every perpetual on every tracked venue in one response
(~25k contracts, ~8.8 MB). Dated futures are filtered out; only perpetuals compare to a MEXC
perpetual card.

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

`CoingeckoListingSyncService` — every 24 hours, and after the direct sync when the card catalog
changes. Disabled with `COINGECKO_ENABLED=false`.

- One `/derivatives` call covers every card, so there is no per-coin budget and no rotation.
- The underlying ticker comes from `index_id`, so the coin-id ambiguity a per-coin lookup would face
  does not arise.
- A coin trades on far more venues than a card can usefully show — the median tracked coin has
  perpetuals on 22 of them — so only the top `COINGECKO_MAX_VENUES_PER_COIN` (default 5) by open
  interest are kept. A venue running several perpetuals on one asset is ranked by its deepest;
  contracts with no reported open interest rank below every contract that has one.
- The cap is applied **after** dropping MEXC itself (every card already lives there) and any venue a
  direct client already reports, so the slots go to genuinely new venues. This is why the sync runs
  after the direct one.
- An empty response, or one that matches no tracked coin, is treated as a failure and the previous
  data is kept. Every tracked coin has a perpetual somewhere, so a total miss means the payload
  changed shape rather than that the venues disappeared.
- `/derivatives` carries no trade URL, so aggregator badges are not links.

## Storage

`coin_listings` holds one row per `(symbol, exchange, market_type, source)`, pruned when the MEXC
contract sync removes a card. Venue names are normalized so `Binance (Futures)` merges into the same
badge as the directly-read `binance` instead of rendering as a near-duplicate venue; only exact
market-type suffixes are stripped, because a trailing parenthetical is not always a market type
(`KiloEx (BSC)`, `GMX Perpetuals V2 (Arbitrum)` name a chain). `CardService` collapses the rows into one `CardExchange` per venue, preferring the
direct source and linking to the spot market where one exists.

## Environment variables

- `EXCHANGE_LISTING_DISABLED_EXCHANGES` — comma-separated exchange ids to skip (e.g. geo-blocked venues).
- `COINGECKO_ENABLED` — `false` disables the aggregator sync entirely.
- `COINGECKO_API_KEY` / `COINGECKO_API_KEY_KIND` (`demo` | `pro`) — a Demo key raises the limit to
  100 calls/min and 10k/month. Keyless access is far stricter, though one call a day fits it.
- `COINGECKO_MAX_VENUES_PER_COIN` — derivatives venues kept per card, 1..50, default 5.
