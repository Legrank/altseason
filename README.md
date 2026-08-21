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

## Docker production deployment

The production stack contains separate backend and frontend images. SQLite data is stored in the
named `altseason-data` volume, while the frontend is published only on `127.0.0.1:8081` for a host
reverse proxy.

```bash
docker compose up -d --build
```

### Updating production

Run the update script from any directory inside the production server:

```bash
bash /path/to/altseason/deploy/update-production.sh
```

The script requires a clean Git working tree and a configured upstream branch. It performs a
fast-forward-only pull, validates the Compose configuration, builds fresh images, recreates the
containers, and waits for the backend health check. The named SQLite data volume is preserved.

The health-check timeout is 120 seconds by default and can be changed when needed:

```bash
DEPLOY_WAIT_TIMEOUT=180 bash /path/to/altseason/deploy/update-production.sh
```

### Production authentication

The public site and its API are protected by HTTP Basic Authentication in the host Nginx config.
Before installing `deploy/nginx/alt.legrank.ru.conf`, create the password file on the server:

```bash
sudo apt-get install apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd-altseason owner
sudo chown root:www-data /etc/nginx/.htpasswd-altseason
sudo chmod 640 /etc/nginx/.htpasswd-altseason
```

Replace `owner` with the desired login. `htpasswd` prompts for the password and stores only its
hash. Then install the config and validate it before reloading Nginx:

```bash
sudo cp deploy/nginx/alt.legrank.ru.conf /etc/nginx/sites-available/alt.legrank.ru.conf
sudo nginx -t
sudo systemctl reload nginx
```

Authentication is enabled only on HTTPS. The HTTP server continues to redirect requests to HTTPS,
and the Docker health check calls the backend directly, so it does not require credentials.

## Telegram Bot

The backend can run a Telegram bot that sends private notifications when a `ratio` level is crossed.

1. Create `backend/.env.local` from `backend/.env.example`.
2. Set:

   ```env
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_ALLOWED_USER_IDS=123456789
   TELEGRAM_ALLOWED_USERNAMES=your_username
   TELEGRAM_DEFAULT_MIN_THRESHOLD=3
   ```

3. Restart the backend.

Security notes:

- The bot starts only when `TELEGRAM_BOT_TOKEN` is set.
- Access is restricted to users listed in `TELEGRAM_ALLOWED_USER_IDS` or `TELEGRAM_ALLOWED_USERNAMES`.
- Only private chats are supported.

Bot commands:

- `/start` enables notifications for the current private chat.
- `/threshold 4` sets the minimum `ratio` level that should trigger messages.
- `/status` shows the current subscription threshold.
- `/stop` disables notifications.
- `/help` shows the command list.

Telegram notifications include:

- `ratio` breakout events for thresholds `>=` the subscriber's configured minimum.
- Price crossing `buyPriceSafe` upward.
- Price crossing `buyPriceRisk` upward.
- Price crossing `sellPrice` downward.
- The same card-level price-crossing event is sent at most once per UTC day.

## Cards API

- `GET /api/cards`
- `GET /api/ratio-threshold-events?threshold=3`
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
  "mexcAvgDailyVolume3m": 12500000,
  "mexcVolume24h": 14800000,
  "mexcPriceUpdatedAt": "2026-06-23T10:05:00.000Z",
  "mexcSyncStatus": "synced"
}
```

Possible `mexcSyncStatus` values:

- `pending`
- `synced`
- `not_found`
- `error`

`GET /api/ratio-threshold-events?threshold=3` returns exact breakout events for one threshold:

```json
[
  {
    "id": 91,
    "symbol": "BTC",
    "threshold": 3,
    "eventAt": "2026-06-29T12:00:00.000Z",
    "crossedThresholdCount": 1
  }
]
```

## MEXC Sync

- On the first backend launch, cards are automatically created for every MEXC USDT futures contract.
- The USDT contract catalog is reconciled once a week: new listings are added and delisted contracts are removed.
- The last successful catalog sync time is stored in SQLite, so restarting the backend does not reset the weekly interval.
- The backend runs one immediate MEXC sync on startup.
- After that it refreshes prices every 5 minutes.
- `buyPriceSafe`, `buyPriceRisk`, and `sellPrice` are optional.
- Manual card prices and MEXC futures price are stored separately.
- A saved symbol like `BTC` maps to the exact MEXC USDT futures contract `BTC_USDT`.
- The synced MEXC value is the futures ticker field `lastPrice`.
- The synced 24h volume is stored separately as `mexcVolume24h`.
- Threshold breakout history is tracked for exact ratio levels `2..10` and kept for the last 30 days.
- A breakout is logged only when `mexcVolume24h` is above the selected ratio threshold versus the 3-month average and is at least `2x` the latest completed daily volume.
- The same `symbol + threshold` is logged at most once per UTC day.
- Telegram subscribers receive only events with `threshold >= their configured minimum`.
- Price-level crossing history is tracked for `buyPriceSafe` up, `buyPriceRisk` up, and `sellPrice` down, with one identical event per card per UTC day.
- Public MEXC futures contract endpoints are used in v1.

All MEXC requests must go through the centralized client in `backend/src/integrations/mexc/`.
Do not call MEXC directly from routes, services, or frontend code.

Detailed integration rules and rate-limit notes are documented in [docs/mexc.md](/C:/Users/User/Documents/altseason/docs/mexc.md).

## Logs

docker logs -f altseason-backend-1
