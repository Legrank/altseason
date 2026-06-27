# Altseason

Single-user MVP for managing crypto cards with manual pricing and live MEXC USDT futures pricing.

## Stack

- Frontend: Vue 3, Vite, TypeScript
- Backend: Fastify, Node.js 22, SQLite via `node:sqlite`

## Run

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the backend:

   ```bash
   npm run dev:backend
   ```

3. Start the frontend in a second terminal:

   ```bash
   npm run dev:frontend
   ```

4. Open `http://localhost:5173`

## Cards API

- `GET /api/cards`
- `POST /api/cards`
- `PUT /api/cards/:id`
- `DELETE /api/cards/:id`

`POST` and `PUT` accept:

```json
{
  "symbol": "BTC",
  "buyPriceSafe": 65000,
  "buyPriceRisk": 62000,
  "sellPrice": 78000
}
```

`GET /api/cards` returns cards with MEXC sync metadata:

```json
{
  "id": 1,
  "symbol": "BTC",
  "buyPriceSafe": 65000,
  "buyPriceRisk": 62000,
  "sellPrice": 78000,
  "createdAt": "2026-06-23T10:00:00.000Z",
  "mexcPrice": 61059.5,
  "mexcPriceUpdatedAt": "2026-06-23T10:05:00.000Z",
  "mexcSyncStatus": "synced"
}
```

Possible `mexcSyncStatus` values:

- `pending`
- `synced`
- `not_found`
- `error`

## MEXC Sync

- The backend runs one immediate MEXC sync on startup.
- After that it refreshes prices every 5 minutes.
- `buyPriceSafe`, `buyPriceRisk`, and `sellPrice` are optional.
- Manual card prices and MEXC futures price are stored separately.
- A saved symbol like `BTC` maps to the exact MEXC USDT futures contract `BTC_USDT`.
- The synced MEXC value is the futures ticker field `lastPrice`.
- Public MEXC futures contract endpoints are used in v1.

All MEXC requests must go through the centralized client in `backend/src/integrations/mexc/`.
Do not call MEXC directly from routes, services, or frontend code.

Detailed integration rules and rate-limit notes are documented in [docs/mexc.md](/C:/Users/User/Documents/altseason/docs/mexc.md).
