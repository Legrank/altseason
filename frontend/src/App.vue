<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import {
  cardsApi,
  priceSignalStatisticsApi,
  ratioThresholdEventsApi,
} from './api'
import CardItem from './components/CardItem.vue'
import CardModal from './components/CardModal.vue'
import PriceSignalStatisticCard from './components/PriceSignalStatisticCard.vue'
import VolumeSignalCard from './components/VolumeSignalCard.vue'
import type { Card, CardPayload, PriceSignalStatistic, RatioThresholdEvent } from './types'

type AppView = 'cards' | 'volume-signals' | 'statistics'
type StatisticStatusFilter = 'all' | 'open' | 'closed'
type VolumeSignalsView = 'current-ratios' | 'threshold-events'
type CardPercentSort =
  | 'default'
  | 'buyPriceSafeMaxIncreasePercent'
  | 'buyPriceRiskMaxIncreasePercent'
  | 'sellPriceMaxDecreasePercent'

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
const priceSignalStatistics = ref<PriceSignalStatistic[]>([])
const statisticsLoading = ref(false)
const statisticsErrorMessage = ref('')
const statisticStatusFilter = ref<StatisticStatusFilter>('all')
const volumeSignalsView = ref<VolumeSignalsView>('current-ratios')
const cardSearchQuery = ref('')
const cardPercentSort = ref<CardPercentSort>('default')
const cardFilters = reactive({
  withAnyManualPrice: false,
  aboveBuyPriceSafe: false,
  aboveBuyPriceRisk: false,
  belowSellPrice: false,
})

const modalState = reactive<{
  open: boolean
  card: Card | null
}>({
  open: false,
  card: null,
})

const eventDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium',
  timeStyle: 'short',
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
        ratio,
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
    }),
)

const filteredVolumeCards = computed(() =>
  sortedVolumeCards.value.filter(
    (card) => card.ratio !== null && card.ratio > volumeRatioThreshold.value,
  ),
)

const normalizedCardSearchQuery = computed(() =>
  cardSearchQuery.value.trim().toUpperCase(),
)

const filteredCards = computed(() => {
  const filtered = cards.value.filter((card) => {
    if (
      normalizedCardSearchQuery.value !== '' &&
      !card.symbol.toUpperCase().startsWith(normalizedCardSearchQuery.value)
    ) {
      return false
    }

    const currentPrice = card.mexcPrice

    if (
      cardFilters.withAnyManualPrice &&
      card.buyPriceSafe === null &&
      card.buyPriceRisk === null &&
      card.sellPrice === null
    ) {
      return false
    }

    if (
      cardFilters.aboveBuyPriceSafe &&
      (currentPrice === null ||
        card.buyPriceSafe === null ||
        currentPrice <= card.buyPriceSafe)
    ) {
      return false
    }

    if (
      cardFilters.aboveBuyPriceRisk &&
      (currentPrice === null ||
        card.buyPriceRisk === null ||
        currentPrice <= card.buyPriceRisk)
    ) {
      return false
    }

    if (
      cardFilters.belowSellPrice &&
      (currentPrice === null ||
        card.sellPrice === null ||
        currentPrice >= card.sellPrice)
    ) {
      return false
    }

    return true
  })

  if (cardPercentSort.value === 'default') {
    return filtered
  }

  const sortKey = cardPercentSort.value

  return filtered.sort((left, right) => {
    const leftValue = left[sortKey]
    const rightValue = right[sortKey]

    if (leftValue === null && rightValue === null) {
      return left.symbol.localeCompare(right.symbol)
    }

    if (leftValue === null) {
      return 1
    }

    if (rightValue === null) {
      return -1
    }

    return rightValue - leftValue || left.symbol.localeCompare(right.symbol)
  })
})

const highlightedThresholdEvents = computed(() =>
  thresholdEvents.value.filter((event) => event.crossedThresholdCount >= 3),
)

const filteredPriceSignalStatistics = computed(() =>
  statisticStatusFilter.value === 'all'
    ? priceSignalStatistics.value
    : priceSignalStatistics.value.filter(
        (statistic) => statistic.status === statisticStatusFilter.value,
      ),
)

const openStatisticCount = computed(
  () =>
    priceSignalStatistics.value.filter((statistic) => statistic.status === 'open')
      .length,
)

const latestMexcSyncAt = computed(() =>
  cards.value.reduce<string | null>((latest, card) => {
    if (!card.mexcPriceUpdatedAt) {
      return latest
    }

    return latest === null || card.mexcPriceUpdatedAt > latest ? card.mexcPriceUpdatedAt : latest
  }, null),
)

function syncViewFromHash() {
  if (window.location.hash === '#volume-signals') {
    currentView.value = 'volume-signals'
    return
  }

  currentView.value = window.location.hash === '#statistics' ? 'statistics' : 'cards'
}

function navigateTo(view: AppView) {
  window.location.hash = view
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
    errorMessage.value =
      error instanceof Error ? error.message : 'Failed to load cards.'
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
    thresholdEvents.value = await ratioThresholdEventsApi.list(
      thresholdEventsThreshold.value,
    )
  } catch (error) {
    thresholdEventsErrorMessage.value =
      error instanceof Error
        ? error.message
        : 'Failed to load threshold events.'
  } finally {
    thresholdEventsLoading.value = false
  }
}

async function loadPriceSignalStatistics(options?: { background?: boolean }) {
  if (!options?.background) {
    statisticsLoading.value = true
  }

  statisticsErrorMessage.value = ''

  try {
    priceSignalStatistics.value = await priceSignalStatisticsApi.list()
  } catch (error) {
    statisticsErrorMessage.value =
      error instanceof Error ? error.message : 'Failed to load signal statistics.'
  } finally {
    statisticsLoading.value = false
  }
}

function resetCardFilters() {
  cardFilters.withAnyManualPrice = false
  cardFilters.aboveBuyPriceSafe = false
  cardFilters.aboveBuyPriceRisk = false
  cardFilters.belowSellPrice = false
}

function handleCardSearchInput() {
  resetCardFilters()
}

function handleCardFilterChange() {
  cardSearchQuery.value = ''
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

async function submitCard(payload: CardPayload) {
  submitting.value = true
  modalErrorMessage.value = ''

  try {
    if (!modalState.card) {
      return
    }

    const updated = await cardsApi.update(modalState.card.id, payload)
    cards.value = cards.value.map((card) =>
      card.id === updated.id ? updated : card,
    )
    closeModal()
  } catch (error) {
    modalErrorMessage.value =
      error instanceof Error ? error.message : 'Failed to save the card.'
  } finally {
    submitting.value = false
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void loadCards({ background: true })
    void loadThresholdEvents({ background: true })
    void loadPriceSignalStatistics({ background: true })
  }
}

watch(thresholdEventsThreshold, () => {
  void loadThresholdEvents()
})

onMounted(() => {
  syncViewFromHash()
  void loadCards()
  void loadThresholdEvents()
  void loadPriceSignalStatistics()
  refreshTimer.value = window.setInterval(() => {
    void loadCards({ background: true })
    void loadThresholdEvents({ background: true })
    void loadPriceSignalStatistics({ background: true })
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
        <div class="hero-sync-status">
          <p class="label">Last MEXC futures sync</p>
          <time v-if="latestMexcSyncAt" :datetime="latestMexcSyncAt">
            {{ formatEventDate(latestMexcSyncAt) }}
          </time>
          <span v-else>No successful sync yet</span>
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
            <button
              type="button"
              class="view-tab"
              :class="{ active: currentView === 'statistics' }"
              @click="navigateTo('statistics')"
            >
              Statistics
            </button>
          </div>
        </div>
      </section>

      <p v-if="errorMessage" class="banner banner-error">{{ errorMessage }}</p>

      <section v-if="loading" class="empty-state">
        <p>Loading cards...</p>
      </section>

      <section
        v-else-if="currentView !== 'statistics' && cards.length === 0"
        class="empty-state"
      >
        <p class="empty-title">No cards saved yet</p>
        <p class="empty-copy">
          Cards will appear here after the automated list update.
        </p>
      </section>

      <section v-else-if="currentView === 'cards'" class="cards-screen">
        <div class="signal-filter-panel cards-filter-panel">
          <div>
            <p class="label">Card filters</p>
            <p class="filter-value">
              Showing {{ filteredCards.length }} of {{ cards.length }} cards
            </p>
          </div>

          <div class="cards-filter-controls">
            <label class="field cards-search-field">
              <span>Search by symbol prefix</span>
              <input
                v-model="cardSearchQuery"
                type="text"
                inputmode="text"
                autocomplete="off"
                placeholder="A, AH, BTC..."
                @input="handleCardSearchInput"
              />
            </label>

            <label class="field cards-sort-field">
              <span>Sort cards</span>
              <select v-model="cardPercentSort">
                <option value="default">Default order</option>
                <option value="buyPriceSafeMaxIncreasePercent">Buy price safe growth ↓</option>
                <option value="buyPriceRiskMaxIncreasePercent">Buy price risk growth ↓</option>
                <option value="sellPriceMaxDecreasePercent">Sell price decline ↓</option>
              </select>
            </label>
          </div>

          <div class="cards-filter-options">
            <label class="filter-toggle">
              <input
                v-model="cardFilters.withAnyManualPrice"
                type="checkbox"
                @change="handleCardFilterChange"
              />
              <span>At least one price is set</span>
            </label>

            <label class="filter-toggle">
              <input
                v-model="cardFilters.aboveBuyPriceSafe"
                type="checkbox"
                @change="handleCardFilterChange"
              />
              <span>Current price above buy price safe</span>
            </label>

            <label class="filter-toggle">
              <input
                v-model="cardFilters.aboveBuyPriceRisk"
                type="checkbox"
                @change="handleCardFilterChange"
              />
              <span>Current price above buy price risk</span>
            </label>

            <label class="filter-toggle">
              <input
                v-model="cardFilters.belowSellPrice"
                type="checkbox"
                @change="handleCardFilterChange"
              />
              <span>Current price below sell price</span>
            </label>
          </div>
        </div>

        <section
          v-if="filteredCards.length === 0"
          class="empty-state signal-empty"
        >
          <p class="empty-title">No cards match the selected filters</p>
          <p class="empty-copy">
            Change or clear the filters to show more symbols.
          </p>
        </section>

        <section v-else class="cards-grid">
          <CardItem
            v-for="card in filteredCards"
            :key="card.id"
            :card="card"
            @edit="openEditModal"
          />
        </section>
      </section>

      <section v-else-if="currentView === 'volume-signals'" class="signal-screen">
        <div
          class="signal-view-switcher"
          role="tablist"
          aria-label="Volume signal views"
        >
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
          <div
            v-if="sortedVolumeCards.length === 0"
            class="empty-state signal-empty"
          >
            <p class="empty-title">No volume data yet</p>
            <p class="empty-copy">
              Wait for MEXC volume sync or backfill to complete, then the
              ranking screen will appear here.
            </p>
          </div>

          <template v-else>
            <div class="signal-filter-panel">
              <div>
                <p class="label">Ratio threshold</p>
                <p class="filter-value">
                  Showing cards with ratio above {{ volumeRatioThreshold }}x
                </p>
              </div>

              <label class="range-field">
                <input
                  v-model.number="volumeRatioThreshold"
                  type="range"
                  min="2"
                  max="10"
                  step="1"
                />
                <div class="range-scale">
                  <span>2x</span>
                  <span>10x</span>
                </div>
              </label>
            </div>

            <section
              v-if="filteredVolumeCards.length === 0"
              class="empty-state signal-empty"
            >
              <p class="empty-title">No cards above the selected threshold</p>
              <p class="empty-copy">
                Lower the ratio slider to include more symbols in the volume
                ranking.
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
              <p class="filter-value">
                Showing exact breakout events for threshold
                {{ thresholdEventsThreshold }}x
              </p>
            </div>

            <label class="range-field">
              <input
                v-model.number="thresholdEventsThreshold"
                type="range"
                min="2"
                max="10"
                step="1"
              />
              <div class="range-scale">
                <span>2x</span>
                <span>10x</span>
              </div>
            </label>
          </div>

          <p
            v-if="thresholdEventsErrorMessage"
            class="banner banner-error signal-banner"
          >
            {{ thresholdEventsErrorMessage }}
          </p>

          <section
            v-if="thresholdEventsLoading"
            class="empty-state signal-empty"
          >
            <p>Loading threshold events...</p>
          </section>

          <section
            v-else-if="thresholdEvents.length === 0"
            class="empty-state signal-empty"
          >
            <p class="empty-title">
              No events for threshold {{ thresholdEventsThreshold }}x
            </p>
            <p class="empty-copy">
              New breakouts will appear here after the next qualifying sync
              cycle.
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
                <div
                  v-for="event in thresholdEvents"
                  :key="event.id"
                  class="event-row"
                >
                  <div>
                    <p class="label">Symbol</p>
                    <p class="event-symbol">{{ event.symbol }}</p>
                  </div>
                  <time class="event-time">{{
                    formatEventDate(event.eventAt)
                  }}</time>
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

              <div
                v-if="highlightedThresholdEvents.length === 0"
                class="event-panel-empty"
              >
                <p>No large jump events for this threshold yet.</p>
              </div>

              <div v-else class="event-list">
                <div
                  v-for="event in highlightedThresholdEvents"
                  :key="`jump-${event.id}`"
                  class="event-row"
                >
                  <div>
                    <p class="label">Symbol</p>
                    <p class="event-symbol">{{ event.symbol }}</p>
                  </div>
                  <div class="event-meta">
                    <span class="jump-badge"
                      >{{ event.crossedThresholdCount }} thresholds</span
                    >
                    <time class="event-time">{{
                      formatEventDate(event.eventAt)
                    }}</time>
                  </div>
                </div>
              </div>
            </article>
          </section>
        </template>
      </section>

      <section v-else class="statistics-screen">
        <div class="signal-filter-panel statistics-summary">
          <div>
            <p class="label">Price-level signal history</p>
            <p class="filter-value">
              {{ openStatisticCount }} open of {{ priceSignalStatistics.length }} signals
            </p>
          </div>

          <div class="status-filter" role="group" aria-label="Signal status filter">
            <button
              v-for="status in (['all', 'open', 'closed'] as const)"
              :key="status"
              type="button"
              :class="{ active: statisticStatusFilter === status }"
              @click="statisticStatusFilter = status"
            >
              {{ status[0].toUpperCase() + status.slice(1) }}
            </button>
          </div>
        </div>

        <p v-if="statisticsErrorMessage" class="banner banner-error signal-banner">
          {{ statisticsErrorMessage }}
        </p>

        <section v-if="statisticsLoading" class="empty-state signal-empty">
          <p>Loading signal statistics...</p>
        </section>

        <section
          v-else-if="filteredPriceSignalStatistics.length === 0"
          class="empty-state signal-empty"
        >
          <p class="empty-title">No signal statistics yet</p>
          <p class="empty-copy">
            A card will appear when the market price crosses a saved price level.
          </p>
        </section>

        <section v-else class="statistics-grid">
          <PriceSignalStatisticCard
            v-for="statistic in filteredPriceSignalStatistics"
            :key="statistic.id"
            :statistic="statistic"
          />
        </section>
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
