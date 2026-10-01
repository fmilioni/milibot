export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1] as number
    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number)
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number)
      const width = ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number)
      return { width, height }
    }
    i += 2 + length
  }
  return null
}
