// Median of the values, rounded to a whole number; null when there are none.
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// A whole-number percentage; null when there is nothing to take it of.
export function percent(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 100) : null;
}
