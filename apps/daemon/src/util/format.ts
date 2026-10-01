const SIZE_UNITS = ['B', 'KB', 'MB', 'GB']

/** "1.2 MB" (English, for the text the models read). */
export function formatBytesEn(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${SIZE_UNITS[unit]}`
}
