<script setup lang="ts">
import { computed } from 'vue'

import type { PriceSignalStatistic } from '../types'

const props = defineProps<{
  statistic: PriceSignalStatistic
}>()

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 8,
})

const kindLabel = computed(() => {
  if (props.statistic.kind === 'buyPriceSafe') {
    return 'Safe buy'
  }

  if (props.statistic.kind === 'buyPriceRisk') {
    return 'Risk buy'
  }

  return 'Sell'
})

const extremeLabel = computed(() =>
  props.statistic.direction === 'up' ? 'Maximum after signal' : 'Minimum after signal',
)

function formatPrice(value: number) {
  return numberFormatter.format(value)
}

function formatPercent(value: number) {
  const normalized = Math.abs(value) < 0.005 ? 0 : value
  return `${normalized > 0 ? '+' : ''}${normalized.toFixed(2)}%`
}
</script>

<template>
  <article class="statistic-card" :class="statistic.status">
    <div class="statistic-card-header">
      <div>
        <p class="label">{{ kindLabel }}</p>
        <h2>{{ statistic.symbol }}</h2>
      </div>
      <span class="status-badge" :class="statistic.status">
        {{ statistic.status === 'open' ? 'Open' : 'Closed' }}
      </span>
    </div>

    <dl class="statistic-metrics">
      <div>
        <dt>Saved level</dt>
        <dd>{{ formatPrice(statistic.levelPrice) }}</dd>
      </div>
      <div>
        <dt>Signal price</dt>
        <dd>{{ formatPrice(statistic.signalPrice) }}</dd>
      </div>
      <div>
        <dt>{{ extremeLabel }}</dt>
        <dd>{{ formatPrice(statistic.extremePrice) }}</dd>
      </div>
      <div class="statistic-performance">
        <dt>Move from signal</dt>
        <dd>{{ formatPercent(statistic.extremeChangePercent) }}</dd>
      </div>
    </dl>

    <div class="statistic-timeline">
      <p>
        Opened
        <time :datetime="statistic.openedAt">
          {{ dateFormatter.format(new Date(statistic.openedAt)) }}
        </time>
      </p>
      <p v-if="statistic.closedAt">
        Closed
        <time :datetime="statistic.closedAt">
          {{ dateFormatter.format(new Date(statistic.closedAt)) }}
        </time>
        <span v-if="statistic.closePrice !== null">
          at {{ formatPrice(statistic.closePrice) }}
        </span>
      </p>
    </div>
  </article>
</template>
