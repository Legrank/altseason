<script setup lang="ts">
import { computed, reactive, watch } from 'vue'

import type { Card } from '../types'

const props = defineProps<{
  open: boolean
  card: Card | null
  errorMessage: string
  submitting: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: { symbol: string; buyPriceSafe: number; buyPriceRisk: number | null; sellPrice: number | null }]
}>()

const form = reactive({
  symbol: '',
  buyPriceSafe: '',
  buyPriceRisk: '',
  sellPrice: ''
})

const title = computed(() => (props.card ? 'Edit card' : 'Create card'))
const buttonLabel = computed(() => (props.card ? 'Save' : 'Create'))

watch(
  () => [props.open, props.card] as const,
  ([open, card]) => {
    if (!open) {
      return
    }

    form.symbol = card?.symbol ?? ''
    form.buyPriceSafe = card ? String(card.buyPriceSafe) : ''
    form.buyPriceRisk = card?.buyPriceRisk === null || card?.buyPriceRisk === undefined ? '' : String(card.buyPriceRisk)
    form.sellPrice = card?.sellPrice === null || card?.sellPrice === undefined ? '' : String(card.sellPrice)
  },
  { immediate: true }
)

function handleSubmit() {
  emit('submit', {
    symbol: form.symbol.trim().toUpperCase(),
    buyPriceSafe: Number(form.buyPriceSafe),
    buyPriceRisk: form.buyPriceRisk === '' ? null : Number(form.buyPriceRisk),
    sellPrice: form.sellPrice === '' ? null : Number(form.sellPrice)
  })
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-panel">
      <div class="modal-header">
        <div>
          <p class="modal-eyebrow">Card editor</p>
          <h2>{{ title }}</h2>
        </div>
        <button type="button" class="icon-button" @click="emit('close')">x</button>
      </div>

      <form class="modal-form" @submit.prevent="handleSubmit">
        <p v-if="props.errorMessage" class="modal-error">{{ props.errorMessage }}</p>

        <label class="field">
          <span>Coin symbol</span>
          <input
            v-model="form.symbol"
            type="text"
            maxlength="12"
            placeholder="BTC"
            autocomplete="off"
            required
          />
        </label>

        <label class="field">
          <span>Buy price safe (USD)</span>
          <input
            v-model="form.buyPriceSafe"
            type="number"
            min="0"
            step="0.000001"
            placeholder="65000"
            required
          />
        </label>

        <label class="field">
          <span>Buy price risk (USD)</span>
          <input
            v-model="form.buyPriceRisk"
            type="number"
            min="0"
            step="0.000001"
            placeholder="Optional"
          />
        </label>

        <label class="field">
          <span>Sell price (USD)</span>
          <input
            v-model="form.sellPrice"
            type="number"
            min="0"
            step="0.000001"
            placeholder="Optional"
          />
        </label>

        <div class="modal-actions">
          <button type="button" class="secondary-button" @click="emit('close')">Cancel</button>
          <button type="submit" class="primary-button" :disabled="submitting">
            {{ submitting ? 'Saving...' : buttonLabel }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
