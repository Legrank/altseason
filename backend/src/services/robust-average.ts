function percentile(sortedValues: number[], p: number): number {
  const index = (sortedValues.length - 1) * p
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.ceil(index)

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex]
  }

  const lowerValue = sortedValues[lowerIndex]
  const upperValue = sortedValues[upperIndex]

  return lowerValue + (upperValue - lowerValue) * (index - lowerIndex)
}

export function calculateRobustAverage(values: number[]): number | null {
  const finiteValues = values.filter((value) => Number.isFinite(value))

  if (finiteValues.length === 0) {
    return null
  }

  const sortedValues = [...finiteValues].sort((left, right) => left - right)
  const q1 = percentile(sortedValues, 0.25)
  const q3 = percentile(sortedValues, 0.75)
  const iqr = q3 - q1
  const upperBound = q3 + 1.5 * iqr
  const filteredValues = sortedValues.filter((value) => value <= upperBound)

  if (filteredValues.length === 0) {
    return null
  }

  const sum = filteredValues.reduce((total, value) => total + value, 0)

  return sum / filteredValues.length
}
