# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-user MVP for tracking crypto "cards". Each card carries three optional manual price levels
(`buyPriceSafe`, `buyPriceRisk`, `sellPrice`) plus live data synced from MEXC USDT perpetual futures
(`lastPrice`, 24h volume, 90-day daily-volume history). The backend derives two families of signals:
volume "ratio" breakouts (24h volume vs. robust 3-month average) and manual price-level crossings.
Both are exposed in the Vue frontend and pushed to a private Telegram bot.

## Commands

```bash
npm install                  # install both workspaces (npm workspaces: frontend, backend)
npm run dev                   # run backend + frontend together (concurrently)
npm run dev:backend           # Fastify on :3001, --watch, tsx, --experimental-sqlite
npm run dev:frontend          # Vite on :5173, proxies /api -> :3001
npm run build                 # backend tsc, then frontend vue-tsc typecheck + vite build
npm test                      # backend node:test suite (only tests that exist)
```

Run one backend test file:

```bash
cd backend && node --experimental-sqlite --import tsx --test src/services/card-service.test.ts
```

One-off maintenance scripts (write directly to `backend/data/cards.sqlite`, hit the live MEXC API):

```bash
cd backend && npm run import:usdt-futures            # add cards for every current USDT contract
cd backend && npm run backfill:mexc-daily-amounts    # fill missing 90-day volume history, rate-limited
cd backend && npm run sync:exchange-listings         # refresh "listed on" data from every exchange API
cd backend && npm run sync:coingecko-listings        # one CoinGecko rotation slice (accepts [db] [budget])
```

Both listing scripts take an optional SQLite path as the first argument (default `backend/data/cards.sqlite`),
so they can be pointed at a scratch copy. `sync:exchange-listings` prints per-venue success/failure, which is
the way to check whether a host is geo-blocked by Binance or Bybit.

There is no linter or formatter configured. Node 22+ is required (`node:sqlite`, `--experimental-sqlite`).
Tests use the built-in `node:test` runner with temp SQLite files or `:memory:` — no test framework.

## Architecture

Layering is strict, top to bottom: `app.ts` (routes) -> services -> `repository.ts` -> SQLite.
`server.ts` is the composition root: it builds every dependency, wires the schedulers, and owns
graceful shutdown. `app.ts` (`createApp`) is dependency-injected and used directly by tests.

- **`repository.ts`** — the entire data layer and, importantly, most of the *business logic for
  signal detection*. `applyMexcSnapshot` is the core: within one transaction it rolls the daily-volume
  history, recomputes the volume ratio, detects threshold crossings, detects price-level crossings,
  opens/updates/closes `price_signal_statistics`, and prunes expired rows. Schema is created and
  migrated in-code in `initializeSchema()` (idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER`/rebuild
  paths for legacy columns) — there are no migration files. WAL mode for file DBs.
- **`services/mexc-sync-service.ts`** — every 5 min (and once on startup) fetches the full futures
  ticker snapshot and calls `repository.applyMexcSnapshot`. On any `MexcClientError` it preserves the
  last good prices and only bumps still-`pending` cards to `error`.
- **`services/mexc-contract-sync-service.ts`** — reconciles the card catalog against MEXC's USDT
  contract list every 7 days (immediately on first launch when no cards exist). Persists the last
  success timestamp in `app_metadata` so restarts don't reset the interval; retries hourly on failure.
  An empty contract list is rejected so a bad response can never wipe the catalog. On completion it
  triggers `mexcSyncService.syncNow()`.
- **`services/card-service.ts`** — read/create/update over `repository`, plus computes the derived
  percentages (`*MaxIncreasePercent` / `MaxDecreasePercent`) and the robust 3-month average for the
  API shape. Note the schema tracks `buy_price_safe_max_observed` etc. as running extremes updated on
  every sync; changing a manual price or the symbol resets the corresponding extreme.
- **`services/telegram-bot-service.ts`** — long-polling bot (no webhook). Runs only when
  `TELEGRAM_BOT_TOKEN` is set AND the allowlist is non-empty. `deliverPendingNotifications()` is
  called after each successful price sync; it walks each subscriber's `last_notified_*_event_id`
  cursors, groups events by symbol+timestamp, and sends. Ratio events are filtered by the subscriber's
  `minThreshold`. User-facing bot copy is in Russian.
- **`services/robust-average.ts`** — shared IQR-outlier-filtered mean (upper bound `Q3 + 1.5*IQR`)
  used for the "average daily volume" everywhere. Used by both repository and card-service.
- **`services/exchange-listing-sync-service.ts`** — every 24h (and after each contract catalog sync)
  reads the public instrument catalog of Binance, Bybit, OKX, Gate, KuCoin and Bitget and records which
  venues list each tracked coin, spot and USDT perpetual. Each venue is replaced independently, so a
  failing or geo-blocked venue never clears the others, and an empty/non-overlapping response is
  rejected rather than written.
- **`services/coingecko-listing-sync-service.ts`** — every 24h, adds venues the direct clients do not
  cover. CoinGecko bills per call (10k/month free), so a run spends a fixed coin budget on the cards
  with the oldest aggregator data and the catalog rotates through over several days.
- **`services/symbol-aliases.ts`** — expands a symbol into itself plus its unscaled ticker
  (`1000BONK` -> `BONK`), stripping only the longest matching scale prefix. Used on both sides of
  every cross-venue symbol comparison.
- **`services/ratio-threshold-event-service.ts`** — thin read wrapper for `GET /api/ratio-threshold-events`.

### MEXC integration boundary (enforced rule)

All MEXC HTTP access goes through `backend/src/integrations/mexc/` (`MexcClient`). Routes, services,
repositories, scripts, and the frontend must never call `contract.mexc.com` directly. The client owns
base URL, endpoint paths, response-envelope validation, and 429/418 `Retry-After` cooldown handling
(after a rate-limit hit it fails fast instead of retrying). See [docs/mexc.md](docs/mexc.md) for the
full rules, endpoint list, rate-limit policy, and exact sync semantics — keep it in sync when changing
sync behavior.

### Exchange listing boundary (enforced rule)

All non-MEXC exchange HTTP access goes through `backend/src/integrations/exchanges/`, and all
CoinGecko access through `backend/src/integrations/coingecko/`. Nothing else may call an exchange or
aggregator host directly. `ExchangeHttpClient` owns the shared transport and the same 429/418
cooldown policy as `MexcClient`. See [docs/exchanges.md](docs/exchanges.md) for the endpoint list,
per-venue payload quirks, geo-blocking, symbol matching and sync semantics — keep it in sync when
changing listing behavior.

Binance (451) and Bybit (403) geo-block some regions. `EXCHANGE_LISTING_DISABLED_EXCHANGES` skips
venues a host cannot reach.

### Signal semantics worth knowing before touching sync code

- Volume ratio = `amount24 / robustAverage(daily amounts)`. A breakout for threshold `T` (2..10) is
  logged only when the ratio crosses `T` upward **and** `amount24 >= 2x` the latest completed daily
  volume **and** that `symbol+T` wasn't already logged this UTC day. Kept 30 days.
- Price-level events: `buyPriceSafe`/`buyPriceRisk` crossing upward, `sellPrice` crossing downward;
  at most one identical event per card per UTC day. Kept 30 days.
- `price_signal_statistics` opens a row on each price-level event and closes it once price moves 10%
  past the signal price (tracking the extreme in between). Unique partial index enforces one open row
  per `symbol+kind+level_price`.
- Symbol `BTC` maps to contract `BTC_USDT`; only exact `*_USDT` perpetuals are supported.

### Frontend

Vue 3 `<script setup>`, no router (view state is the URL hash: `#volume-signals`, `#statistics`).
`src/api.ts` is the only fetch layer, all under `/api` (Vite-proxied in dev, same-origin via nginx in
prod). Polls every 60s and on tab focus. `frontend/src/types.ts` is a hand-maintained mirror of the
backend's API types in `backend/src/types.ts` — update both together.

## Deployment

`docker compose up -d --build` builds two images from the multi-stage `Dockerfile` (`backend` target =
Node; `frontend` target = nginx serving the built SPA on `127.0.0.1:8081`). SQLite lives in the named
`altseason-data` volume. `compose.yaml` requires `backend/.env.local` to exist.

Production updates: `bash deploy/update-production.sh` (ff-only pull, requires clean tree + upstream +
a populated Telegram config in `.env.local`, rebuilds, recreates, waits on healthcheck;
`DEPLOY_WAIT_TIMEOUT` overrides the 120s wait). Public site + API sit behind HTTP Basic Auth in the
host nginx (`deploy/nginx/alt.legrank.ru.conf`). Backend logs: `docker logs -f altseason-backend-1`.

Backend env vars: `PORT` (3001), `HOST` (0.0.0.0), `LOG_LEVEL`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_USERNAMES`, `TELEGRAM_DEFAULT_MIN_THRESHOLD` (2..10).
`EXCHANGE_LISTING_DISABLED_EXCHANGES` (csv of exchange ids), `COINGECKO_ENABLED` (`false` disables),
`COINGECKO_API_KEY`, `COINGECKO_API_KEY_KIND` (`demo` | `pro`), `COINGECKO_DAILY_COIN_BUDGET` (1..1000,
default 100). `config.ts` also loads `backend/.env.local` / `backend/.env` manually (no dotenv dep).
