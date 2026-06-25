import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateRobustAverage } from './robust-average.js'

test('excludes anomalously large values before averaging', () => {
  const result = calculateRobustAverage([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 10000])

  assert.equal(result, 104.5)
})

test('keeps ordinary values when there are no high outliers', () => {
  const result = calculateRobustAverage([10, 20, 30, 40])

  assert.equal(result, 25)
})

test('returns null when no finite values are available', () => {
  const result = calculateRobustAverage([Number.NaN, Number.POSITIVE_INFINITY])

  assert.equal(result, null)
})
