/** The only URLs the app hands to the default browser: http(s), never `file:`, `smb:`, `javascript:` or app schemes. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
