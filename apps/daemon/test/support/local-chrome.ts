import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { LineChannel } from '../../src/runtime/cdp/client'
import { RELAY_SCRIPT } from '../../src/runtime/cdp/scripts/relay.generated'

const programFiles = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]

const CANDIDATES = [
  process.env.MILIBOT_TEST_CHROME,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux (Debian/Ubuntu/Fedora packages, snap)
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  // Windows
  ...programFiles.flatMap((dir) =>
    dir
      ? [
          join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(dir, 'Chromium', 'Application', 'chrome.exe'),
        ]
      : [],
  ),
]

export function findChrome(): string | null {
  return CANDIDATES.find((p): p is string => !!p && existsSync(p)) ?? null
}

export interface LocalChrome {
  port: number
  /** The same relay the VM runs, as a local process talking to this Chrome. */
  channel(): LineChannel
  close(): Promise<void>
}

/** Headless Chrome with its profile in `TMPDIR`. */
export async function startLocalChrome(binary: string): Promise<LocalChrome> {
  const profile = mkdtempSync(join(tmpdir(), 'chrome-'))
  const chrome = spawn(
    binary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const portFile = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 20_000
  let port = 0
  while (!port) {
    if (Date.now() > deadline) throw new Error('Chrome did not open its DevTools port')
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0
    if (!port) await new Promise((r) => setTimeout(r, 100))
  }
  const relays = new Set<ChildProcess>()
  return {
    port,
    channel(): LineChannel {
      let relay: ChildProcess | null = null
      return {
        async start(onLine, onClose) {
          relay = spawn(process.execPath, ['-e', RELAY_SCRIPT], {
            env: { ...process.env, CDP_PORT: String(port) },
            stdio: ['pipe', 'pipe', 'inherit'],
          })
          relays.add(relay)
          createInterface({ input: relay.stdout as NodeJS.ReadableStream }).on('line', onLine)
          relay.on('exit', () => onClose('relay exited'))
        },
        async send(line) {
          relay?.stdin?.write(`${line}\n`)
        },
        async close() {
          relay?.kill()
        },
      }
    },
    async close() {
      for (const r of relays) r.kill()
      const exited = new Promise((r) => chrome.once('exit', r))
      chrome.kill()
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
      rmSync(profile, { recursive: true, force: true })
    },
  }
}
