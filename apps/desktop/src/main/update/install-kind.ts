export type InstallKind = 'mac' | 'nsis' | 'appimage' | 'deb'

export interface InstallFacts {
  platform: NodeJS.Platform
  packaged: boolean
  /** `milibot.autoUpdate` of the packaged package.json (off on macOS without a Developer ID). */
  buildAllows: boolean
  /** `$APPIMAGE`: the AppImage file the app runs from. */
  appImage: string | undefined
  /** `Resources/package-type`, written by electron-builder for deb/rpm/pacman builds. */
  packageType: string | null
}

/**
 * How this install updates itself, or null when it can't: a dev run, a build without the switch, or a Linux
 * install that is neither the AppImage nor the deb (the unpacked folder, rpm/pacman we don't ship). The
 * AppImage wins over `package-type`: both are built from the same folder.
 */
export function installKind(facts: InstallFacts): InstallKind | null {
  if (!facts.packaged || !facts.buildAllows) return null
  if (facts.platform === 'darwin') return 'mac'
  if (facts.platform === 'win32') return 'nsis'
  if (facts.platform !== 'linux') return null
  if (facts.appImage) return 'appimage'
  return facts.packageType === 'deb' ? 'deb' : null
}
