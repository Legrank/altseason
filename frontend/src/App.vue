<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import { cardsApi, ratioThresholdEventsApi } from './api'
import CardItem from './components/CardItem.vue'
import CardModal from './components/CardModal.vue'
import VolumeSignalCard from './components/VolumeSignalCard.vue'
import type { Card, RatioThresholdEvent } from './types'

type AppView = 'cards' | 'volume-signals'
type VolumeSignalsView = 'current-ratios' | 'threshold-events'

const cards = ref<Card[]>([])
const loading = ref(true)
const submitting = ref(false)
const errorMessage = ref('')
const modalErrorMessage = ref('')
const refreshTimer = ref<number | null>(null)
const currentView = ref<AppView>('cards')
const volumeRatioThreshold = ref(2)
const thresholdEventsThreshold = ref(2)
const thresholdEvents = ref<RatioThresholdEvent[]>([])
const thresholdEventsLoading = ref(false)
const thresholdEventsErrorMessage = ref('')
const volumeSignalsView = ref<VolumeSignalsView>('current-ratios')

const modalState = reactive<{
  open: boolean
  card: Card | null
}>({
  open: false,
  card: null
})

const eventDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium',
  timeStyle: 'short'
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

const filteredVolumeCards = computed(() =>
  sortedVolumeCards.value.filter((card) => card.ratio !== null && card.ratio > volumeRatioThreshold.value)
)

const highlightedThresholdEvents = computed(() =>
  thresholdEvents.value.filter((event) => event.crossedThresholdCount >= 3)
)

function syncViewFromHash() {
  currentView.value = window.location.hash === '#volume-signals' ? 'volume-signals' : 'cards'
}

function navigateTo(view: AppView) {
  window.location.hash = view === 'volume-signals' ? 'volume-signals' : 'cards'
}

function formatEventDate(value: string) {
  return eventDateFormatter.format(new Date(value))
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

async function loadThresholdEvents(options?: { background?: boolean }) {
  if (!options?.background) {
    thresholdEventsLoading.value = true
  }

  thresholdEventsErrorMessage.value = ''

  try {
    thresholdEvents.value = await ratioThresholdEventsApi.list(thresholdEventsThreshold.value)
  } catch (error) {
    thresholdEventsErrorMessage.value =
      error instanceof Error ? error.message : 'Failed to load threshold events.'
  } finally {
    thresholdEventsLoading.value = false
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
    void loadThresholdEvents({ background: true })
  }
}

watch(thresholdEventsThreshold, () => {
  void loadThresholdEvents()
})

onMounted(() => {
  syncViewFromHash()
  void loadCards()
  void loadThresholdEvents()
  refreshTimer.value = window.setInterval(() => {
    void loadCards({ background: true })
    void loadThresholdEvents({ background: true })
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
          <p class="hero-copy" v-else>Monitor live ratios and threshold breakouts for MEXC volume spikes.</p>
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

      <section v-else class="signal-screen">
        <div class="signal-view-switcher" role="tablist" aria-label="Volume signal views">
          <button
            type="button"
            class="signal-view-tab"
            :class="{ active: volumeSignalsView === 'current-ratios' }"
            @click="volumeSignalsView = 'current-ratios'"
          >
            Current ratios
          </button>
          <button
            type="button"
            class="signal-view-tab"
            :class="{ active: volumeSignalsView === 'threshold-events' }"
            @click="volumeSignalsView = 'threshold-events'"
          >
            Threshold events
          </button>
        </div>

        <template v-if="volumeSignalsView === 'current-ratios'">
          <div v-if="sortedVolumeCards.length === 0" class="empty-state signal-empty">
            <p class="empty-title">No volume data yet</p>
            <p class="empty-copy">
              Wait for MEXC volume sync or backfill to complete, then the ranking screen will appear here.
            </p>
          </div>

          <template v-else>
            <div class="signal-filter-panel">
              <div>
                <p class="label">Ratio threshold</p>
                <p class="filter-value">Showing cards with ratio above {{ volumeRatioThreshold }}x</p>
              </div>

              <label class="range-field">
                <input v-model.number="volumeRatioThreshold" type="range" min="2" max="10" step="1" />
                <div class="range-scale">
                  <span>2x</span>
                  <span>10x</span>
                </div>
              </label>
            </div>

            <section v-if="filteredVolumeCards.length === 0" class="empty-state signal-empty">
              <p class="empty-title">No cards above the selected threshold</p>
              <p class="empty-copy">
                Lower the ratio slider to include more symbols in the volume ranking.
              </p>
            </section>

            <section v-else class="signal-grid">
              <VolumeSignalCard
                v-for="card in filteredVolumeCards"
                :key="card.id"
                :symbol="card.symbol"
                :average-volume="card.averageVolume"
                :volume24h="card.volume24h"
                :ratio="card.ratio"
              />
            </section>
          </template>
        </template>

        <template v-else>
          <div class="signal-filter-panel">
            <div>
              <p class="label">Threshold history</p>
              <p class="filter-value">Showing exact breakout events for threshold {{ thresholdEventsThreshold }}x</p>
            </div>

            <label class="range-field">
              <input v-model.number="thresholdEventsThreshold" type="range" min="2" max="10" step="1" />
              <div class="range-scale">
                <span>2x</span>
                <span>10x</span>
              </div>
            </label>
          </div>

          <p v-if="thresholdEventsErrorMessage" class="banner banner-error signal-banner">
            {{ thresholdEventsErrorMessage }}
          </p>

          <section v-if="thresholdEventsLoading" class="empty-state signal-empty">
            <p>Loading threshold events...</p>
          </section>

          <section v-else-if="thresholdEvents.length === 0" class="empty-state signal-empty">
            <p class="empty-title">No events for threshold {{ thresholdEventsThreshold }}x</p>
            <p class="empty-copy">
              New breakouts will appear here after the next qualifying sync cycle.
            </p>
          </section>

          <section v-else class="events-layout">
            <article class="event-panel">
              <div class="event-panel-header">
                <div>
                  <p class="label">Threshold events</p>
                  <h2>Exact {{ thresholdEventsThreshold }}x breakouts</h2>
                </div>
              </div>

              <div class="event-list">
                <div v-for="event in thresholdEvents" :key="event.id" class="event-row">
                  <div>
                    <p class="label">Symbol</p>
                    <p class="event-symbol">{{ event.symbol }}</p>
                  </div>
                  <time class="event-time">{{ formatEventDate(event.eventAt) }}</time>
                </div>
              </div>
            </article>

            <article class="event-panel">
              <div class="event-panel-header">
                <div>
                  <p class="label">Large jumps</p>
                  <h2>3+ thresholds in one sync</h2>
                </div>
              </div>

              <div v-if="highlightedThresholdEvents.length === 0" class="event-panel-empty">
                <p>No large jump events for this threshold yet.</p>
              </div>

              <div v-else class="event-list">
                <div v-for="event in highlightedThresholdEvents" :key="`jump-${event.id}`" class="event-row">
                  <div>
                    <p class="label">Symbol</p>
                    <p class="event-symbol">{{ event.symbol }}</p>
                  </div>
                  <div class="event-meta">
                    <span class="jump-badge">{{ event.crossedThresholdCount }} thresholds</span>
                    <time class="event-time">{{ formatEventDate(event.eventAt) }}</time>
                  </div>
                </div>
              </div>
            </article>
          </section>
        </template>
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
