import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSymbolCandidates, normalizeSymbol } from './symbol-aliases.js'

test('normalizes symbols to trimmed upper case', () => {
  assert.equal(normalizeSymbol('  btc '), 'BTC')
})

test('returns the symbol itself when it carries no scale prefix', () => {
  assert.deepEqual(buildSymbolCandidates('PEPE'), ['PEPE'])
})

test('adds the unscaled ticker for scaled contracts', () => {
  assert.deepEqual(buildSymbolCandidates('1000BONK'), ['1000BONK', 'BONK'])
  assert.deepEqual(buildSymbolCandidates('1000000MOG'), ['1000000MOG', 'MOG'])
})

test('strips only the longest matching prefix so no partial-scale garbage is produced', () => {
  assert.deepEqual(buildSymbolCandidates('1000000BABYDOGE'), ['1000000BABYDOGE', 'BABYDOGE'])
})

test('keeps a symbol that is nothing but a scale prefix intact', () => {
  assert.deepEqual(buildSymbolCandidates('1000'), ['1000'])
})

test('ignores blank symbols', () => {
  assert.deepEqual(buildSymbolCandidates('   '), [])
})
