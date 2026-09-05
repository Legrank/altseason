<script setup lang="ts">
import type { Card, CardExchange, ExchangeMarketType } from '../types'

const props = defineProps<{
  card: Card
}>()

const emit = defineEmits<{
  edit: [card: Card]
}>()

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const priceFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 6,
})

const volumeFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
})

const percentageFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
})

function formatPrice(price: number) {
  return priceFormatter.format(price)
}

function formatOptionalPrice(price: number | null) {
  return price === null ? 'Not set' : formatPrice(price)
}

function formatVolume(volume: number | null) {
  return volume === null ? 'Unavailable' : volumeFormatter.format(volume)
}

function formatDate(value: string) {
  return dateFormatter.format(new Date(value))
}

function formatPercentage(value: number) {
  return percentageFormatter.format(value)
}

const marketTypeLabels: Record<ExchangeMarketType, string> = {
  spot: 'Spot',
  futures: 'Futures',
}

function formatMarketTypes(marketTypes: ExchangeMarketType[]) {
  return marketTypes.map((marketType) => marketTypeLabels[marketType][0]).join('')
}

function describeExchange(exchange: CardExchange) {
  const markets = exchange.marketTypes
    .map((marketType) => marketTypeLabels[marketType])
    .join(', ')

  return exchange.source === 'exchange'
    ? `${exchange.label}: ${markets}`
    : `${exchange.label}: ${markets} (reported by CoinGecko)`
}
</script>

<template>
  <article class="card">
    <div class="card-body">
      <div>
        <p class="label">Symbol</p>
        <div class="card-header">
          <h2>{{ props.card.symbol }}</h2>
          <p class="price price-now">
            {{
              props.card.mexcPrice === null
                ? 'Unavailable'
                : formatPrice(props.card.mexcPrice)
            }}
          </p>
        </div>
      </div>

      <div class="metrics">
        <div>
          <p class="label">Buy price safe</p>
          <p class="price price-with-change">
            <span>{{ formatOptionalPrice(props.card.buyPriceSafe) }}</span>
            <span
              v-if="props.card.buyPriceSafeMaxIncreasePercent !== null"
              class="price-change price-change-up"
              title="Maximum price growth since this level was saved"
            >
              +{{ formatPercentage(props.card.buyPriceSafeMaxIncreasePercent) }}%
            </span>
          </p>
        </div>

        <div>
          <p class="label">Buy price risk</p>
          <p class="price price-secondary price-with-change">
            <span>{{ formatOptionalPrice(props.card.buyPriceRisk) }}</span>
            <span
              v-if="props.card.buyPriceRiskMaxIncreasePercent !== null"
              class="price-change price-change-up"
              title="Maximum price growth since this level was saved"
            >
              +{{ formatPercentage(props.card.buyPriceRiskMaxIncreasePercent) }}%
            </span>
          </p>
        </div>

        <div>
          <p class="label">Sell price</p>
          <p class="price price-secondary price-with-change">
            <span>{{ formatOptionalPrice(props.card.sellPrice) }}</span>
            <span
              v-if="props.card.sellPriceMaxDecreasePercent !== null"
              class="price-change price-change-down"
              title="Maximum price decline since this level was saved"
            >
              −{{ formatPercentage(props.card.sellPriceMaxDecreasePercent) }}%
            </span>
          </p>
        </div>
      </div>

      <div class="exchanges">
        <p class="label">Also listed on</p>
        <div v-if="props.card.exchanges.length > 0" class="exchange-badges">
          <component
            :is="exchange.tradeUrl === null ? 'span' : 'a'"
            v-for="exchange in props.card.exchanges"
            :key="exchange.exchange"
            class="exchange-badge"
            :class="{ aggregated: exchange.source === 'coingecko' }"
            :title="describeExchange(exchange)"
            v-bind="
              exchange.tradeUrl === null
                ? {}
                : {
                    href: exchange.tradeUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  }
            "
          >
            {{ exchange.label }}
            <span class="exchange-markets">{{
              formatMarketTypes(exchange.marketTypes)
            }}</span>
          </component>
        </div>
        <p v-else class="exchange-empty">MEXC only</p>
      </div>

      <div
        v-if="props.card.youtubeUrl !== null || props.card.telegramPostUrl !== null"
        class="card-links"
      >
        <a
          v-if="props.card.youtubeUrl !== null"
          class="card-link"
          :href="props.card.youtubeUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          YouTube
        </a>
        <a
          v-if="props.card.telegramPostUrl !== null"
          class="card-link"
          :href="props.card.telegramPostUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          Telegram
        </a>
      </div>

      <div
        v-if="
          props.card.mexcSyncStatus === 'not_found' ||
          props.card.mexcSyncStatus === 'error'
        "
        class="sync-panel"
      >
        <span
          class="sync-badge"
          :class="
            props.card.mexcSyncStatus === 'not_found' ? 'missing' : 'error'
          "
        >
          {{
            props.card.mexcSyncStatus === 'not_found'
              ? 'Contract not found'
              : 'Sync error'
          }}
        </span>

        <p v-if="props.card.mexcSyncStatus === 'not_found'" class="sync-copy">
          Contract {{ props.card.symbol }}_USDT is not available on MEXC
          futures.
        </p>
        <p v-else class="sync-copy">
          MEXC futures sync is temporarily unavailable. Last successful data is
          preserved.
        </p>
      </div>
    </div>

    <div class="card-actions">
      <button
        type="button"
        class="secondary-button"
        @click="emit('edit', props.card)"
      >
        Edit
      </button>
    </div>
  </article>
</template>
<style scoped>
.card-header {
  display: flex;
  gap: 0.25rem;
}

.price-with-change {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.45rem;
}

.price-change {
  font-size: 0.9rem;
  font-weight: 700;
}

.price-change-up {
  color: #73f2cf;
}

.price-change-down {
  color: #ff8f8f;
}

.exchanges {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.exchange-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.exchange-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #d8e4f5;
  text-decoration: none;
  background: rgba(120, 160, 220, 0.16);
  border: 1px solid rgba(158, 199, 255, 0.28);
  border-radius: 999px;
  padding: 0.15rem 0.6rem;
}

a.exchange-badge:hover {
  border-color: rgba(158, 199, 255, 0.75);
}

/* Venues that only the aggregator reported are less certain than a direct API read. */
.exchange-badge.aggregated {
  background: transparent;
  color: #9aa8bd;
  border-style: dashed;
}

.exchange-markets {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  opacity: 0.7;
}

.exchange-empty {
  margin: 0;
  font-size: 0.85rem;
  color: #9aa8bd;
}

.card-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.card-link {
  font-size: 0.85rem;
  font-weight: 600;
  color: #9ec7ff;
  text-decoration: none;
  border: 1px solid rgba(158, 199, 255, 0.35);
  border-radius: 999px;
  padding: 0.2rem 0.7rem;
}

.card-link:hover {
  border-color: rgba(158, 199, 255, 0.75);
}
</style>
