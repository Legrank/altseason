<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'

import { cardsApi } from './api'
import CardModal from './components/CardModal.vue'
import type { Card, MexcSyncStatus } from './types'

const cards = ref<Card[]>([])
const loading = ref(true)
const submitting = ref(false)
const errorMessage = ref('')
const refreshTimer = ref<number | null>(null)

const modalState = reactive<{
  open: boolean
  card: Card | null
}>({
  open: false,
  card: null
})

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium',
  timeStyle: 'short'
})

const priceFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 6
})

function formatPrice(price: number) {
  return priceFormatter.format(price)
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

async function loadCards(options?: { background?: boolean }) {
  if (!options?.background) {
    loading.value = true
  }

  errorMessage.value = ''

  try {
    cards.value = await cardsApi.list()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to load cards.'
  } finally {
    loading.value = false
  }
}

function openCreateModal() {
  modalState.open = true
  modalState.card = null
}

function openEditModal(card: Card) {
  modalState.open = true
  modalState.card = card
}

function closeModal() {
  modalState.open = false
  modalState.card = null
}

async function submitCard(payload: { symbol: string; price: number }) {
  submitting.value = true
  errorMessage.value = ''

  try {
    if (modalState.card) {
      const updated = await cardsApi.update(modalState.card.id, payload)
      cards.value = cards.value.map((card) => (card.id === updated.id ? updated : card))
    } else {
      const created = await cardsApi.create(payload)
      cards.value = [created, ...cards.value]
    }

    closeModal()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to save the card.'
  } finally {
    submitting.value = false
  }
}

async function deleteCard(card: Card) {
  errorMessage.value = ''

  try {
    await cardsApi.remove(card.id)
    cards.value = cards.value.filter((item) => item.id !== card.id)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to delete the card.'
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void loadCards({ background: true })
  }
}

onMounted(() => {
  void loadCards()
  refreshTimer.value = window.setInterval(() => {
    void loadCards({ background: true })
  }, 60_000)
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onUnmounted(() => {
  if (refreshTimer.value !== null) {
    window.clearInterval(refreshTimer.value)
  }

  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<template>
  <div class="shell">
    <main class="layout">
      <section class="hero">
        <div>
          <p class="eyebrow">Altseason / MEXC Watch</p>
          <h1>Crypto cards with live MEXC futures pricing</h1>
          <p class="hero-copy">
            Manual price stays editable. MEXC USDT futures price is synced in the backend every
            5 minutes and reflected here on the next refresh.
          </p>
        </div>

        <button class="primary-button" type="button" @click="openCreateModal">
          Create new card
        </button>
      </section>

      <p v-if="errorMessage" class="banner banner-error">{{ errorMessage }}</p>

      <section v-if="loading" class="empty-state">
        <p>Loading cards...</p>
      </section>

      <section v-else-if="cards.length === 0" class="empty-state">
        <p class="empty-title">No cards saved yet</p>
        <p class="empty-copy">
          Create the first symbol and the backend will start tracking the matching MEXC USDT
          futures contract.
        </p>
      </section>

      <section v-else class="cards-grid">
        <article v-for="card in cards" :key="card.id" class="card">
          <div class="card-topline">
            <span class="chip">FUTURES / USDT</span>
            <span class="timestamp">{{ formatDate(card.createdAt) }}</span>
          </div>

          <div class="card-body">
            <div>
              <p class="label">Symbol</p>
              <h2>{{ card.symbol }}</h2>
            </div>

            <div class="metrics">
              <div>
                <p class="label">Manual price</p>
                <p class="price">{{ formatPrice(card.price) }}</p>
              </div>

              <div>
                <p class="label">MEXC futures price</p>
                <p class="price price-secondary">
                  {{ card.mexcPrice === null ? 'Unavailable' : formatPrice(card.mexcPrice) }}
                </p>
              </div>
            </div>

            <div class="sync-panel">
              <span class="sync-badge" :class="getMexcStatusClass(card.mexcSyncStatus)">
                {{ getMexcStatusLabel(card.mexcSyncStatus) }}
              </span>

              <p v-if="card.mexcSyncStatus === 'synced' && card.mexcPriceUpdatedAt" class="sync-copy">
                Last MEXC futures update: {{ formatDate(card.mexcPriceUpdatedAt) }}
              </p>
              <p v-else-if="card.mexcSyncStatus === 'not_found'" class="sync-copy">
                Contract {{ card.symbol }}_USDT is not available on MEXC futures.
              </p>
              <p v-else-if="card.mexcSyncStatus === 'error'" class="sync-copy">
                MEXC futures sync is temporarily unavailable. Last successful data is preserved.
              </p>
              <p v-else class="sync-copy">
                Waiting for the next backend sync cycle.
              </p>
            </div>
          </div>

          <div class="card-actions">
            <button type="button" class="secondary-button" @click="openEditModal(card)">
              Edit
            </button>
            <button type="button" class="danger-button" @click="deleteCard(card)">
              Delete
            </button>
          </div>
        </article>
      </section>
    </main>

    <CardModal
      :open="modalState.open"
      :card="modalState.card"
      :submitting="submitting"
      @close="closeModal"
      @submit="submitCard"
    />
  </div>
</template>
