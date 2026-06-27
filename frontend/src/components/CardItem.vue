<script setup lang="ts">
import type { Card, MexcSyncStatus } from '../types'

const props = defineProps<{
  card: Card
}>()

const emit = defineEmits<{
  edit: [card: Card]
  delete: [card: Card]
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

function getMexcStatusLabel(status: MexcSyncStatus) {
  switch (status) {
    case 'synced':
      return 'Futures synced'
    case 'not_found':
      return 'Contract not found'
    case 'error':
      return 'Sync error'
    case 'pending':
    default:
      return 'Sync pending'
  }
}

function getMexcStatusClass(status: MexcSyncStatus) {
  return {
    synced: status === 'synced',
    pending: status === 'pending',
    missing: status === 'not_found',
    error: status === 'error'
  }
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

      <div class="sync-panel">
        <span class="sync-badge" :class="getMexcStatusClass(props.card.mexcSyncStatus)">
          {{ getMexcStatusLabel(props.card.mexcSyncStatus) }}
        </span>

        <p v-if="props.card.mexcSyncStatus === 'synced' && props.card.mexcPriceUpdatedAt" class="sync-copy">
          Last MEXC futures update: {{ formatDate(props.card.mexcPriceUpdatedAt) }}
        </p>
        <p v-else-if="props.card.mexcSyncStatus === 'not_found'" class="sync-copy">
          Contract {{ props.card.symbol }}_USDT is not available on MEXC futures.
        </p>
        <p v-else-if="props.card.mexcSyncStatus === 'error'" class="sync-copy">
          MEXC futures sync is temporarily unavailable. Last successful data is preserved.
        </p>
        <p v-else class="sync-copy">
          Waiting for the next backend sync cycle.
        </p>
      </div>
    </div>

    <div class="card-actions">
      <button type="button" class="secondary-button" @click="emit('edit', props.card)">
        Edit
      </button>
      <button type="button" class="danger-button" @click="emit('delete', props.card)">
        Delete
      </button>
    </div>
  </article>
</template>
