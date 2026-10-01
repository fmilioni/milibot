import { type PlatformKind, platformKind } from '@/lib/platform'

type Tree = Record<string, unknown>

const isTree = (value: unknown): value is Tree =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `base` with every leaf of `overrides` written over it (same shape). */
function overlay(base: Tree, overrides: Tree): Tree {
  const out: Tree = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    const current = out[key]
    out[key] = isTree(value) && isTree(current) ? overlay(current, value) : value
  }
  return out
}

/**
 * The texts for this OS. The base texts are the macOS ones (Mac, Finder, Keychain); on Linux and
 * Windows the neutral variants under `platformPc` (same keys) replace them.
 */
export function localeFor<T extends { platformPc: Tree }>(locale: T, kind: PlatformKind = platformKind()): T {
  return kind === 'mac' ? locale : (overlay(locale as unknown as Tree, locale.platformPc) as T)
}
