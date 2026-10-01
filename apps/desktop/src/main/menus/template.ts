import type { Language } from '@milibot/shared'
import type { MenuItemConstructorOptions } from 'electron'

import { type MainStringKey, mainText } from '../app/i18n'

export interface MenuActions {
  /** Absent when the daemon is managed outside the app (`MILIBOT_DAEMON_EXTERNAL=1`). */
  stopService?: () => void
  showLogs: () => void
  /** "Toggle Developer Tools" in the View menu: unpackaged builds only. */
  devTools?: boolean
}

const separator: MenuItemConstructorOptions = { type: 'separator' }

type MenuText = (key: MainStringKey) => string

/** macOS adds "Paste and Match Style" and the Speech submenu. */
function editMenu(text: MenuText, mac: boolean): MenuItemConstructorOptions {
  const common: MenuItemConstructorOptions[] = [
    { role: 'undo', label: text('menuUndo') },
    { role: 'redo', label: text('menuRedo') },
    separator,
    { role: 'cut', label: text('menuCut') },
    { role: 'copy', label: text('menuCopy') },
    { role: 'paste', label: text('menuPaste') },
  ]
  const deleteItem: MenuItemConstructorOptions = { role: 'delete', label: text('menuDelete') }
  const selectAll: MenuItemConstructorOptions = { role: 'selectAll', label: text('menuSelectAll') }
  return {
    label: text('menuEdit'),
    submenu: mac
      ? [
          ...common,
          { role: 'pasteAndMatchStyle', label: text('menuPasteAndMatchStyle') },
          deleteItem,
          selectAll,
          separator,
          {
            label: text('menuSpeech'),
            submenu: [
              { role: 'startSpeaking', label: text('menuStartSpeaking') },
              { role: 'stopSpeaking', label: text('menuStopSpeaking') },
            ],
          },
        ]
      : [...common, deleteItem, separator, selectAll],
  }
}

function viewMenu(
  text: MenuText,
  labelKey: 'menuView' | 'menuViewWindow',
  devTools: boolean,
): MenuItemConstructorOptions {
  return {
    label: text(labelKey),
    submenu: [
      { role: 'reload', label: text('menuReload') },
      { role: 'forceReload', label: text('menuForceReload') },
      ...(devTools ? [{ role: 'toggleDevTools', label: text('menuToggleDevTools') } as const] : []),
      separator,
      { role: 'resetZoom', label: text('menuActualSize') },
      { role: 'zoomIn', label: text('menuZoomIn') },
      { role: 'zoomOut', label: text('menuZoomOut') },
      separator,
      { role: 'togglefullscreen', label: text('menuToggleFullScreen') },
    ],
  }
}

/**
 * The macOS menu bar with labels in the app language. Every standard item keeps its role, so the
 * native behavior (clipboard, zoom, full screen, window list, Help search) is untouched.
 */
export function appMenuTemplate(
  language: Language,
  appName: string,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  const text: MenuText = (key) => mainText(language, key, { app: appName })
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: text('menuAbout') },
        separator,
        ...(actions.stopService
          ? [{ label: text('stopServiceMenu'), click: actions.stopService }, separator]
          : []),
        { role: 'services', label: text('menuServices') },
        separator,
        { role: 'hide', label: text('menuHide') },
        { role: 'hideOthers', label: text('menuHideOthers') },
        { role: 'unhide', label: text('menuShowAll') },
        separator,
        { role: 'quit', label: text('menuQuit') },
      ],
    },
    {
      label: text('menuFile'),
      submenu: [{ role: 'close', label: text('menuCloseWindow') }],
    },
    editMenu(text, true),
    viewMenu(text, 'menuView', Boolean(actions.devTools)),
    {
      label: text('menuWindow'),
      role: 'window',
      submenu: [
        { role: 'minimize', label: text('menuMinimize') },
        { role: 'zoom', label: text('menuZoom') },
        separator,
        { role: 'front', label: text('menuBringAllToFront') },
      ],
    },
    {
      label: text('menuHelp'),
      role: 'help',
      submenu: [{ label: text('menuShowLogs'), click: actions.showLogs }],
    },
  ]
}

/**
 * Linux and Windows: a lean menu inside each window (File, Edit, View, Help), without the macOS-only
 * roles (services, hide, speech, window list). On Linux the windows hide it until Alt is pressed.
 */
export function windowMenuTemplate(
  language: Language,
  appName: string,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  const text: MenuText = (key) => mainText(language, key, { app: appName })
  return [
    {
      label: text('menuFile'),
      submenu: [
        { role: 'close', label: text('menuCloseWindow') },
        ...(actions.stopService
          ? [separator, { label: text('stopServiceMenu'), click: actions.stopService }]
          : []),
        separator,
        { role: 'quit', label: text('menuExit') },
      ],
    },
    editMenu(text, false),
    viewMenu(text, 'menuViewWindow', Boolean(actions.devTools)),
    {
      label: text('menuHelp'),
      role: 'help',
      submenu: [
        { label: text('menuShowLogs'), click: actions.showLogs },
        separator,
        { role: 'about', label: text('menuAbout') },
      ],
    },
  ]
}

/** The menu for the platform: the macOS menu bar or the Linux/Windows window menu. */
export function menuTemplate(
  platform: NodeJS.Platform,
  language: Language,
  appName: string,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  return platform === 'darwin'
    ? appMenuTemplate(language, appName, actions)
    : windowMenuTemplate(language, appName, actions)
}
