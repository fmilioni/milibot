import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findUp } from '../../util/fs'

export interface DesignAssets {
  /** Folder with Tailwind's `index.css`, `theme.css`, `preflight.css` and `utilities.css`. */
  tailwindDir: string
  /** Inter variable font files (latin and latin-ext subsets). */
  interLatin: string
  interLatinExt: string
}

/**
 * Files the design compiler embeds: `Resources/assets/design` in the packaged app (`tailwindcss/` and
 * `fonts/`), the daemon's node_modules when running from the repository; `MILIBOT_DESIGN_ASSETS` overrides.
 */
export function defaultDesignAssets(override: string | null = null): DesignAssets | null {
  const start = dirname(fileURLToPath(import.meta.url))
  const packaged = override ?? findUp(start, join('assets', 'design', 'tailwindcss'))
  if (packaged) {
    const root = override ?? dirname(packaged)
    return {
      tailwindDir: join(root, 'tailwindcss'),
      interLatin: join(root, 'fonts', 'inter-latin-wght-normal.woff2'),
      interLatinExt: join(root, 'fonts', 'inter-latin-ext-wght-normal.woff2'),
    }
  }
  const tailwind = findUp(start, join('node_modules', 'tailwindcss', 'theme.css'))
  const inter = findUp(start, join('node_modules', '@fontsource-variable', 'inter', 'files'))
  if (!tailwind || !inter) return null
  return {
    tailwindDir: dirname(tailwind),
    interLatin: join(inter, 'inter-latin-wght-normal.woff2'),
    interLatinExt: join(inter, 'inter-latin-ext-wght-normal.woff2'),
  }
}
