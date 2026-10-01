/** Semantic colors shared by chips, dots and status texts. */
export type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'neutral'

/** Tinted background with colored text (chips, badges). */
export const TONE_SOFT: Record<Tone, string> = {
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  muted: 'bg-surface-3 text-fg-muted',
  neutral: 'bg-surface-3 text-fg-secondary',
}

/** Solid fill (dots, bars). */
export const TONE_FILL: Record<Tone, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-fg-muted/60',
  neutral: 'bg-fg-muted/60',
}

export const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-fg-muted',
  neutral: 'text-fg-secondary',
}
