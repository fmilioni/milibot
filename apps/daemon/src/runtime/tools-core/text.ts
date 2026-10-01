/** Whitespace collapsed and clipped to `max` characters (an ellipsis included). */
export function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Text over `max` characters keeps its first 40% and its end around a note of how much was cut. */
export function clipMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  const head = Math.floor(max * 0.4)
  return `${value.slice(0, head)}\n… [${value.length - max} characters omitted] …\n${value.slice(-(max - head))}`
}

// OSC (links, titles), CSI (colors, cursor moves), charset selections and other two-character escapes.
/* eslint-disable no-control-regex -- matching terminal escape sequences is the point */
const ANSI_ESCAPES =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()#][0-9A-Za-z]|\x1b[@-Z\\-_=>]|\x9b[0-?]*[ -/]*[@-~]/g
/* eslint-enable no-control-regex */

export function stripAnsi(text: string): string {
  return text.includes('\x1b') || text.includes('\x9b') ? text.replace(ANSI_ESCAPES, '') : text
}

/** The key names are compared by: case, accents and surrounding space ignored. */
export function foldKey(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}
