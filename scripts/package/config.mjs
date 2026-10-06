import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { APP_ID } from '../../apps/desktop/src/main/platform/app-id.ts'

/** Where installed apps look for new versions: the repository's published (non-draft) GitHub releases. */
export const UPDATE_FEED = { provider: 'github', owner: 'fmilioni', repo: 'milibot' }

const isSigned = (env) => Boolean(env.CSC_LINK || env.CSC_NAME)

/**
 * Whether the packaged app updates itself. Squirrel.Mac refuses to swap an ad-hoc signed app (its code
 * requirement fails), so on macOS it needs a Developer ID build; Windows and Linux need no signature.
 */
export function autoUpdateEnabled({ platform, env }) {
  return platform !== 'darwin' || isSigned(env)
}

/**
 * The staged app's package.json (main and preload bundle their dependencies: no node_modules). Main reads
 * `milibot.autoUpdate` to decide whether to start the updater.
 */
export function appPackageJson({ version, homepage }, { autoUpdate }) {
  return {
    name: 'milibot',
    productName: 'Milibot',
    version,
    description: 'Milibot',
    author: 'Milibot',
    homepage,
    // Linux: the window's app_id/WM_CLASS, so desktops match windows to milibot.desktop.
    desktopName: 'milibot.desktop',
    main: 'out/main/index.js',
    milibot: { autoUpdate },
  }
}

/**
 * The DMG window: the background's size in points (Finder sizes the window to the 1x image) and the icons'
 * centers. `pnpm dmg:background` draws the background around these positions.
 */
export const DMG_LAYOUT = {
  width: 660,
  height: 400,
  // Finder counts the title bar (and the path bar, when the user shows it) in the window size, which is the
  // background's size: the image is this much taller so the whole composition stays visible.
  finderChrome: 52,
  iconSize: 112,
  app: [170, 190],
  applications: [490, 190],
}

function signingConfig({ env, desktop }) {
  const signing = isSigned(env)
  // Every nested binary gets the app's entitlements, so the bundled QEMU keeps the hypervisor one.
  const entitlements = join(desktop, 'build/entitlements.mac.plist')
  if (!signing) {
    // Apple Silicon refuses to run unsigned code: ad-hoc sign (no hardened runtime, no notarization).
    return {
      identity: '-',
      hardenedRuntime: false,
      notarize: false,
      entitlements,
      entitlementsInherit: entitlements,
    }
  }
  const notarize = Boolean(
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) ||
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
    env.APPLE_KEYCHAIN_PROFILE,
  )
  return {
    identity: env.CSC_NAME || undefined,
    hardenedRuntime: true,
    entitlements,
    entitlementsInherit: entitlements,
    notarize,
  }
}

function keyringResources(keyring) {
  if (!keyring) return []
  return [
    {
      from: keyring.keyring,
      to: 'daemon/node_modules/@napi-rs/keyring',
      filter: ['package.json', 'index.js', 'LICENSE'],
    },
    {
      from: keyring.native,
      to: `daemon/node_modules/@napi-rs/keyring-${keyring.suffix}`,
      filter: ['package.json', '*.node'],
    },
  ]
}

/**
 * electron-builder deletes every Chromium locale not listed. Windows/Linux name them `en-US.pak`/`pt-BR.pak`
 * (macOS `en.lproj`/`pt_BR.lproj`); without them `app.getLocale()` is empty and Portuguese users start in English.
 */
const LOCALE_PAKS = ['en-US.pak', 'pt-BR.pak']

function afterPack(platform) {
  return ({ appOutDir }) => {
    // A custom electronDist keeps Electron's placeholder app; ours is app.asar.
    rmSync(
      platform === 'darwin'
        ? join(appOutDir, 'Milibot.app/Contents/Resources/default_app.asar')
        : join(appOutDir, 'resources/default_app.asar'),
      { force: true },
    )
    if (platform === 'darwin') return
    for (const pak of LOCALE_PAKS) {
      if (!existsSync(join(appOutDir, 'locales', pak))) throw new Error(`package: locales/${pak} is missing`)
    }
  }
}

/**
 * electron-builder's configuration. `skipExecutableEdit`: a Windows cross-build without wine, which can
 * run neither rcedit (icon, version info) nor signtool.
 */
export function buildConfig({
  ctx,
  electronVersion,
  appDir,
  node,
  vmScripts,
  vmBin,
  natives,
  skipExecutableEdit = false,
  year = new Date().getFullYear(),
}) {
  const { platform, cross, env, root, desktop, daemon, distDir, stage } = ctx
  const { onnxBin } = natives
  return {
    // Also the AppUserModelID the app sets on Windows.
    appId: APP_ID,
    productName: 'Milibot',
    copyright: `© ${year} Milibot`,
    electronVersion,
    // Cross-builds let electron-builder download the target's Electron.
    ...(cross ? {} : { electronDist: join(desktop, 'node_modules/electron/dist') }),
    electronLanguages: ['en', 'en-US', 'pt-BR', 'pt_BR'],
    directories: { app: appDir, output: distDir, buildResources: join(desktop, 'build') },
    files: ['**/*'],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    // Writes app-update.yml into the app and the latest*.yml feed next to the installers; the release
    // workflow uploads them (electron-builder itself never publishes: `publish: 'never'` in index.mjs).
    publish: UPDATE_FEED,
    afterPack: afterPack(platform),
    // Flipped by electron-builder right before signing. The daemon and the VM scripts run on the bundled
    // Node, never on Electron as Node, so the binary never needs ELECTRON_RUN_AS_NODE. The asar header hash
    // is embedded on macOS (Info.plist) and Windows (an executable resource); Electron has none on Linux.
    // MILIBOT_PACKAGE_INSPECT=1 keeps `--inspect` working for verification builds.
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: env.MILIBOT_PACKAGE_INSPECT === '1',
      onlyLoadAppFromAsar: true,
      enableEmbeddedAsarIntegrityValidation: platform !== 'linux',
      resetAdHocDarwinSignature: platform === 'darwin',
    },
    extraResources: [
      { from: node, to: platform === 'win32' ? 'node/node.exe' : 'node/bin/node' },
      {
        from: join(daemon, 'dist'),
        to: 'daemon',
        filter: ['main.js', 'runtime-main.js', 'embedding-worker.js'],
      },
      { from: join(stage, 'daemon-package.json'), to: 'daemon/package.json' },
      {
        from: natives.betterSqlite,
        to: 'daemon/node_modules/better-sqlite3',
        filter: ['package.json', 'LICENSE', 'lib/**/*', natives.sqlitePrebuild],
      },
      // Local embedding models (knowledge base). Only this platform's binding and runtime library (on macOS
      // libonnxruntime.1.30.0.dylib is an identical copy; the other platforms are ~200 MB).
      {
        from: natives.onnxNode,
        to: 'daemon/node_modules/onnxruntime-node',
        filter: [
          'package.json',
          'dist/*.js',
          `${onnxBin}/onnxruntime_binding.node`,
          ...natives.onnxLibs.map((lib) => `${onnxBin}/${lib}`),
        ],
      },
      ...keyringResources(natives.keyring),
      {
        from: natives.onnxCommon,
        to: 'daemon/node_modules/onnxruntime-common',
        filter: ['package.json', 'dist/**/*.js', 'dist/*/package.json'],
      },
      // Built-in skills (SKILL.md folders), found by the daemon at Resources/assets/skills.
      { from: join(root, 'packages/agent/skills'), to: 'assets/skills' },
      // Design compiler: Tailwind's stylesheets and the Inter font embedded in frames (Resources/assets/design).
      {
        from: natives.tailwindDir,
        to: 'assets/design/tailwindcss',
        filter: ['index.css', 'theme.css', 'preflight.css', 'utilities.css', 'LICENSE'],
      },
      {
        from: join(natives.interDir, 'files'),
        to: 'assets/design/fonts',
        filter: ['inter-latin-wght-normal.woff2', 'inter-latin-ext-wght-normal.woff2'],
      },
      { from: join(natives.interDir, 'LICENSE'), to: 'assets/design/fonts/LICENSE' },
      {
        from: join(root, 'vm'),
        to: 'vm',
        filter: [
          'provision.sh',
          'provision.d/**/*',
          'versions.env',
          'golden-revision',
          'guest/**/*',
          'guest-agent/dist/guest-agent.mjs',
        ],
      },
      { from: vmScripts, to: 'vm/scripts' },
      { from: vmBin, to: 'vm/bin' },
    ],
    mac: {
      category: 'public.app-category.developer-tools',
      icon: join(desktop, 'build/icon.icns'),
      minimumSystemVersion: '13.0',
      darkModeSupport: true,
      ...signingConfig(ctx),
    },
    // The updater installs macOS updates from the zip (the dmg is for the first install).
    zip: { artifactName: 'Milibot-${version}-${arch}-mac.${ext}' },
    dmg: {
      artifactName: 'Milibot-${version}-${arch}.${ext}',
      title: 'Milibot ${version}',
      writeUpdateInfo: false,
      // LZFSE: smaller and faster to open than zlib, readable since macOS 10.11.
      format: 'ULFO',
      // dmg-background@2x.png next to it is merged into a HiDPI TIFF.
      background: join(desktop, 'build/dmg-background.png'),
      iconSize: DMG_LAYOUT.iconSize,
      contents: [
        { x: DMG_LAYOUT.app[0], y: DMG_LAYOUT.app[1], type: 'file' },
        { x: DMG_LAYOUT.applications[0], y: DMG_LAYOUT.applications[1], type: 'link', path: '/Applications' },
      ],
    },
    linux: {
      icon: join(desktop, 'build/icons'),
      category: 'Development',
      executableName: 'milibot',
      synopsis: 'Teams of AI bots on a shared Linux VM',
      description: 'Teams of AI bots operating a shared Debian VM.',
      maintainer: 'Milibot',
      syncDesktopName: true,
    },
    appImage: { artifactName: 'Milibot-${version}-${arch}.${ext}' },
    deb: {
      artifactName: 'milibot_${version}_${arch}.${ext}',
      fpm: [
        // Any Secret Service provider; without one the daemon falls back to an encrypted file (with a warning).
        '--deb-recommends',
        'gnome-keyring | kwalletmanager | keepassxc',
      ],
    },
    win: {
      icon: join(desktop, 'build/icon.ico'),
      ...(skipExecutableEdit ? { signAndEditExecutable: false } : {}),
    },
    nsis: {
      artifactName: 'Milibot-${version}-${arch}-setup.${ext}',
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      installerIcon: join(desktop, 'build/icon.ico'),
      uninstallerIcon: join(desktop, 'build/icon.ico'),
      shortcutName: 'Milibot',
      // Stops the daemon before files are replaced or removed; removes the login item on uninstall.
      include: join(desktop, 'build/installer.nsh'),
    },
  }
}

/**
 * Authenticode is opt-in: electron-builder signs with `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (or
 * `CSC_LINK` + `CSC_KEY_PASSWORD`); without them the installer is unsigned and SmartScreen warns.
 */
export function windowsSigningNotice({ platform, env }, config) {
  if (platform !== 'win32') return
  if (!(env.WIN_CSC_LINK || env.CSC_LINK)) {
    console.warn(
      'package: WARNING: no WIN_CSC_LINK/CSC_LINK, the Windows installer is NOT signed (SmartScreen will warn)',
    )
  } else if (config.win.signAndEditExecutable === false) {
    console.warn(
      'package: WARNING: signing credentials ignored: cross-build without wine cannot run signtool/rcedit',
    )
  } else {
    console.log('package: signing the Windows executables with Authenticode')
  }
  if (config.win.signAndEditExecutable === false) {
    console.warn(
      "package: WARNING: no wine: Milibot.exe keeps Electron's icon and version info (build on Windows for a release)",
    )
  }
}
