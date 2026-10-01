import type { Session } from 'electron'

import { isAppUrl, type RendererLocation, rendererLocation } from './trust'

/**
 * What the app's page uses: `navigator.clipboard.writeText` (copy buttons) and `requestFullscreen` (VM
 * window). Reading the clipboard goes through IPC and notifications come from the main process.
 */
const ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen'])

export function permissionAllowed(permission: string, url: string, where: RendererLocation): boolean {
  return ALLOWED.has(permission) && isAppUrl(url, where)
}

/** Denies every permission a page asks for or checks, except the few the app's own page needs. */
export function applyPermissionPolicy(session: Session): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permissionAllowed(permission, details.requestingUrl || contents.getURL(), rendererLocation()))
  })
  session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permissionAllowed(permission, details.requestingUrl || contents?.getURL() || '', rendererLocation()),
  )
}
