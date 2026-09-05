/**
 * MEXC lists low-priced assets as scaled perpetuals (`1000BONK_USDT`, `1000000MOG_USDT`) while
 * spot venues and aggregators list the unscaled ticker. Other venues scale by their own factors,
 * so both sides of a comparison are expanded into candidates and matched on any overlap.
 */
const SCALE_PREFIXES = ['1000000', '100000', '10000', '1000'] as const

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}

/**
 * Returns the symbol itself plus, when it carries a scale prefix, the unscaled ticker.
 * Only the longest matching prefix is stripped — testing every prefix against `1000000MOG`
 * would otherwise yield nonsense candidates such as `0MOG`.
 */
export function buildSymbolCandidates(symbol: string): string[] {
  const normalized = normalizeSymbol(symbol)

  if (!normalized) {
    return []
  }

  const candidates = [normalized]
  const prefix = SCALE_PREFIXES.find(
    (candidate) => normalized.startsWith(candidate) && normalized.length > candidate.length
  )

  if (prefix !== undefined) {
    candidates.push(normalized.slice(prefix.length))
  }

  return candidates
}
