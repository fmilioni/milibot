export type PlatformKind = 'mac' | 'linux' | 'windows'

/** The OS the app runs on (`process.platform` from the preload). */
export function platformKind(
  platform: string | undefined = typeof window === 'undefined' ? undefined : window.milibot?.platform,
): PlatformKind {
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'mac'
}

/** `~/…` instead of the home folder (macOS `/Users/<me>`, Linux `/home/<me>`, Windows `C:\Users\<me>`). */
export function shortPath(path: string, kind: PlatformKind = platformKind()): string {
  if (kind === 'windows') return path.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')
  if (kind === 'linux') return path.replace(/^(\/home\/[^/]+|\/root)(?=\/|$)/, '~')
  return path.replace(/^\/Users\/[^/]+/, '~')
}

/**
 * Whether a keydown is the host's paste shortcut: Cmd+V on the Mac (Ctrl+V there stays the VM's own),
 * Ctrl+V or Ctrl+Shift+V elsewhere (AltGr, which reports Ctrl+Alt on Windows, is left alone).
 */
export function isHostPaste(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey'>,
  kind: PlatformKind,
): boolean {
  const isV = event.key.toLowerCase() === 'v' || event.code === 'KeyV'
  if (!isV) return false
  if (kind === 'mac') return event.metaKey
  return event.ctrlKey && !event.altKey && !event.metaKey
}

/** The shortcut modifier of this OS is held: ⌘ on macOS, Ctrl on Linux and Windows. */
export function hasModKey(
  event: { metaKey: boolean; ctrlKey: boolean },
  kind: PlatformKind = platformKind(),
): boolean {
  return kind === 'mac' ? event.metaKey : event.ctrlKey
}

/** A shortcut label: `⇧⌘C` on macOS, `Ctrl+Shift+C` on Linux and Windows. */
export function shortcutLabel(key: string, shift = false, kind: PlatformKind = platformKind()): string {
  if (kind === 'mac') return `${shift ? '⇧' : ''}⌘${key}`
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`
}
