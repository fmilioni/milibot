type ClassValue = string | false | null | undefined | 0

/** Joins the truthy class names. No Tailwind conflict resolution: callers never pass two utilities for the same property. */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ')
}
