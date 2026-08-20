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
  timeStyle: 'short'
})

const priceFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 6
})

const volumeFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2
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

</script>

<template>
  <article class="card">
    <div class="card-topline">
      <span class="chip">FUTURES / USDT</span>
      <span class="timestamp">{{ formatDate(props.card.createdAt) }}</span>
    </div>

    <div class="card-body">
      <div>
        <p class="label">Symbol</p>
        <h2>{{ props.card.symbol }}</h2>
      </div>

      <div class="metrics">
        <div>
          <p class="label">Buy price safe</p>
          <p class="price">{{ formatOptionalPrice(props.card.buyPriceSafe) }}</p>
        </div>

        <div>
          <p class="label">Buy price risk</p>
          <p class="price price-secondary">{{ formatOptionalPrice(props.card.buyPriceRisk) }}</p>
        </div>

        <div>
          <p class="label">Sell price</p>
          <p class="price price-secondary">{{ formatOptionalPrice(props.card.sellPrice) }}</p>
        </div>

        <div>
          <p class="label">MEXC futures price</p>
          <p class="price price-secondary">
            {{ props.card.mexcPrice === null ? 'Unavailable' : formatPrice(props.card.mexcPrice) }}
          </p>
        </div>

        <div>
          <p class="label">Avg daily volume (3M)</p>
          <p class="price price-secondary">{{ formatVolume(props.card.mexcAvgDailyVolume3m) }}</p>
        </div>
      </div>

      <div
        v-if="props.card.mexcSyncStatus === 'not_found' || props.card.mexcSyncStatus === 'error'"
        class="sync-panel"
      >
        <span
          class="sync-badge"
          :class="props.card.mexcSyncStatus === 'not_found' ? 'missing' : 'error'"
        >
          {{ props.card.mexcSyncStatus === 'not_found' ? 'Contract not found' : 'Sync error' }}
        </span>

        <p v-if="props.card.mexcSyncStatus === 'not_found'" class="sync-copy">
          Contract {{ props.card.symbol }}_USDT is not available on MEXC futures.
        </p>
        <p v-else class="sync-copy">
          MEXC futures sync is temporarily unavailable. Last successful data is preserved.
        </p>
      </div>
    </div>

    <div class="card-actions">
      <button type="button" class="secondary-button" @click="emit('edit', props.card)">
        Edit
      </button>
    </div>
  </article>
</template>
