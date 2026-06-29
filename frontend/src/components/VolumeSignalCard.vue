<script setup lang="ts">
defineProps<{
  symbol: string
  averageVolume: number | null
  volume24h: number | null
  ratio: number | null
}>()

const volumeFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2
})

const ratioFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2
})

function formatVolume(volume: number | null) {
  return volume === null ? 'Unavailable' : volumeFormatter.format(volume)
}

function formatRatio(ratio: number | null) {
  return ratio === null ? 'Unavailable' : `${ratioFormatter.format(ratio)}x`
}
</script>

<template>
  <article class="signal-card">
    <div class="signal-card-topline">
      <span class="chip">Volume pulse</span>
      <p class="ratio-pill">{{ formatRatio(ratio) }}</p>
    </div>

    <div class="signal-card-body">
      <div>
        <p class="label">Symbol</p>
        <h2>{{ symbol }}</h2>
      </div>

      <div class="signal-metrics">
        <div>
          <p class="label">Average volume</p>
          <p class="price price-secondary">{{ formatVolume(averageVolume) }}</p>
        </div>

        <div>
          <p class="label">Volume 24h</p>
          <p class="price price-secondary">{{ formatVolume(volume24h) }}</p>
        </div>

        <div>
          <p class="label">24h / average</p>
          <p class="price">{{ formatRatio(ratio) }}</p>
        </div>
      </div>
    </div>
  </article>
</template>
