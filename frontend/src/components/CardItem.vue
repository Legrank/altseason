<script setup lang="ts">
import type { Card } from '../types'

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
</style>
