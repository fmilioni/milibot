/**
 * The installer's `appId`: `scripts/package/config.mjs` imports this file with Node's type stripping, so
 * it holds plain constants only. Windows matches notifications and taskbar grouping to the Start-menu
 * shortcut by this AppUserModelID.
 */
export const APP_ID = 'app.milibot.desktop'

/** Only makes sure the daemon runs, then exits without a window (login items). */
export const START_DAEMON_FLAG = '--start-daemon'

/** Stops the daemon gracefully, then exits without a window (the Windows installer before it replaces files). */
export const STOP_DAEMON_FLAG = '--stop-daemon'
