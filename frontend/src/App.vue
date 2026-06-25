<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'

import { cardsApi } from './api'
import CardItem from './components/CardItem.vue'
import CardModal from './components/CardModal.vue'
import type { Card } from './types'

const cards = ref<Card[]>([])
const loading = ref(true)
const submitting = ref(false)
const errorMessage = ref('')
const modalErrorMessage = ref('')
const refreshTimer = ref<number | null>(null)

const modalState = reactive<{
  open: boolean
  card: Card | null
}>({
  open: false,
  card: null
})

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
  modalErrorMessage.value = ''
  modalState.open = true
  modalState.card = null
}

function openEditModal(card: Card) {
  modalErrorMessage.value = ''
  modalState.open = true
  modalState.card = card
}

function closeModal() {
  modalErrorMessage.value = ''
  modalState.open = false
  modalState.card = null
}

async function submitCard(payload: {
  symbol: string
  buyPriceSafe: number
  buyPriceRisk: number | null
  sellPrice: number | null
}) {
  submitting.value = true
  modalErrorMessage.value = ''

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
    modalErrorMessage.value = error instanceof Error ? error.message : 'Failed to save the card.'
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
        <CardItem
          v-for="card in cards"
          :key="card.id"
          :card="card"
          @edit="openEditModal"
          @delete="deleteCard"
        />
      </section>
    </main>

    <CardModal
      :open="modalState.open"
      :card="modalState.card"
      :error-message="modalErrorMessage"
      :submitting="submitting"
      @close="closeModal"
      @submit="submitCard"
    />
  </div>
</template>
