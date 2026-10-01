/** A few characters at the ends of a secret, the rest hidden. */
export function maskSecret(value: string): string {
  const dots = '••••••••'
  if (value.length <= 8) return `${dots}${value.slice(-1)}`
  const head = value.length >= 16 ? value.slice(0, Math.min(8, Math.floor(value.length / 4))) : ''
  return `${head}${dots}${value.slice(-3)}`
}
