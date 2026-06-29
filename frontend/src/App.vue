<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import { cardsApi } from './api'
import CardItem from './components/CardItem.vue'
import CardModal from './components/CardModal.vue'
import VolumeSignalCard from './components/VolumeSignalCard.vue'
import type { Card } from './types'

type AppView = 'cards' | 'volume-signals'

const cards = ref<Card[]>([])
const loading = ref(true)
const submitting = ref(false)
const errorMessage = ref('')
const modalErrorMessage = ref('')
const refreshTimer = ref<number | null>(null)
const currentView = ref<AppView>('cards')

const modalState = reactive<{
  open: boolean
  card: Card | null
}>({
  open: false,
  card: null
})

const sortedVolumeCards = computed(() =>
  cards.value
    .map((card) => {
      const ratio =
        card.mexcVolume24h !== null &&
        card.mexcAvgDailyVolume3m !== null &&
        card.mexcAvgDailyVolume3m > 0
          ? card.mexcVolume24h / card.mexcAvgDailyVolume3m
          : null

      return {
        id: card.id,
        symbol: card.symbol,
        averageVolume: card.mexcAvgDailyVolume3m,
        volume24h: card.mexcVolume24h,
        ratio
      }
    })
    .sort((left, right) => {
      if (left.ratio === null && right.ratio === null) {
        return left.symbol.localeCompare(right.symbol)
      }

      if (left.ratio === null) {
        return 1
      }

      if (right.ratio === null) {
        return -1
      }

      return right.ratio - left.ratio || left.symbol.localeCompare(right.symbol)
    })
)

function syncViewFromHash() {
  currentView.value = window.location.hash === '#volume-signals' ? 'volume-signals' : 'cards'
}

function navigateTo(view: AppView) {
  window.location.hash = view === 'volume-signals' ? 'volume-signals' : 'cards'
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
  buyPriceSafe: number | null
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
  syncViewFromHash()
  void loadCards()
  refreshTimer.value = window.setInterval(() => {
    void loadCards({ background: true })
  }, 60_000)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('hashchange', syncViewFromHash)
})

onUnmounted(() => {
  if (refreshTimer.value !== null) {
    window.clearInterval(refreshTimer.value)
  }

  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener('hashchange', syncViewFromHash)
})
</script>

<template>
  <div class="shell">
    <main class="layout">
      <section class="hero">
        <div>
          <p class="eyebrow">Altseason / MEXC Watch</p>
          <h1>{{ currentView === 'cards' ? 'Crypto cards with live MEXC futures pricing' : 'Volume ratio signals' }}</h1>
          <p class="hero-copy" v-if="currentView === 'cards'">
            Manual price stays editable. MEXC USDT futures price is synced in the backend every
            5 minutes and reflected here on the next refresh.
          </p>
          <p class="hero-copy" v-else>
            Symbols are sorted by the ratio of the latest 24-hour volume to the 3-month average
            daily volume, from highest to lowest.
          </p>
        </div>

        <div class="hero-actions">
          <div class="view-switcher" role="tablist" aria-label="App screens">
            <button
              type="button"
              class="view-tab"
              :class="{ active: currentView === 'cards' }"
              @click="navigateTo('cards')"
            >
              Cards
            </button>
            <button
              type="button"
              class="view-tab"
              :class="{ active: currentView === 'volume-signals' }"
              @click="navigateTo('volume-signals')"
            >
              Volume screen
            </button>
          </div>

          <button v-if="currentView === 'cards'" class="primary-button" type="button" @click="openCreateModal">
            Create new card
          </button>
        </div>
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

      <section v-else-if="currentView === 'cards'" class="cards-grid">
        <CardItem
          v-for="card in cards"
          :key="card.id"
          :card="card"
          @edit="openEditModal"
          @delete="deleteCard"
        />
      </section>

      <section v-else-if="sortedVolumeCards.length === 0" class="empty-state">
        <p class="empty-title">No volume data yet</p>
        <p class="empty-copy">
          Wait for MEXC volume sync or backfill to complete, then the ranking screen will appear here.
        </p>
      </section>

      <section v-else class="signal-grid">
        <VolumeSignalCard
          v-for="card in sortedVolumeCards"
          :key="card.id"
          :symbol="card.symbol"
          :average-volume="card.averageVolume"
          :volume24h="card.volume24h"
          :ratio="card.ratio"
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
