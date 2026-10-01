import { decodePng, encodePng, type RgbImage } from '../media/png'

const RING = [229, 72, 77] as const
const HALO = [255, 255, 255] as const

/** Draws a hollow ring (white halo + red stroke) centered on the clicked point; the center stays visible. */
function drawClickRing(image: RgbImage, cx: number, cy: number, radius = 16, stroke = 3): void {
  const outer = radius + stroke + 1
  for (let y = Math.max(0, cy - outer); y <= Math.min(image.height - 1, cy + outer); y++) {
    for (let x = Math.max(0, cx - outer); x <= Math.min(image.width - 1, cx + outer); x++) {
      const d = Math.hypot(x - cx, y - cy)
      const color =
        Math.abs(d - radius) <= stroke / 2 ? RING : Math.abs(d - radius) <= stroke / 2 + 1.2 ? HALO : null
      if (!color) continue
      const at = (y * image.width + x) * 3
      image.pixels[at] = color[0]
      image.pixels[at + 1] = color[1]
      image.pixels[at + 2] = color[2]
    }
  }
}

/** The screenshot with a ring on the clicked point, or null when the PNG format is not supported. */
export function markClick(png: Uint8Array, x: number, y: number): Uint8Array | null {
  const image = decodePng(png)
  if (!image) return null
  drawClickRing(image, Math.round(x), Math.round(y))
  return encodePng(image)
}
