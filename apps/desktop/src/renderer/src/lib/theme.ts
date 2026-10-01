import type { ThemePreference } from '@milibot/shared'

let preference: ThemePreference = 'system'
let media: MediaQueryList | null = null

function apply(): void {
  const dark = preference === 'dark' || (preference === 'system' && Boolean(media?.matches))
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

/** Applies the system theme until the settings arrive, and follows the system's changes after. */
export function startThemeSync(): void {
  if (media) return
  media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', apply)
  apply()
}

export function setThemePreference(next: ThemePreference): void {
  preference = next
  apply()
  void window.milibot.setThemeSource(next)
}
