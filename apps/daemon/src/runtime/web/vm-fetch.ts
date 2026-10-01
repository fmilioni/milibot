import { gunzipSync } from 'node:zlib'

import { type Bot } from '@milibot/shared'

import { DaemonError } from '../../errors'
import { botLinuxUser, type GuestClient } from '../vm'
import {
  FETCH_EXEC_MAX_OUTPUT,
  FETCH_EXEC_TIMEOUT_MS,
  FETCH_MAX_BYTES,
  FETCH_MAX_REDIRECTS,
  FETCH_TIMEOUT_MS,
} from './limits'
import { FETCH_SCRIPT } from './scripts/fetch.generated'
import { BLOCKED_SUBNETS } from './url-policy'

export interface VmFetchRequest {
  url: string
  httpFallback: boolean
  acceptLanguage: string
}

export interface VmFetchResult {
  status: number
  url: string
  redirects: string[]
  contentType: string | null
  charset: string | null
  truncated: boolean
  body: Buffer
}

const FETCH_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** What the script reads on stdin; `allowPrivate` is only for tests against a local server. */
export function fetchScriptInput(request: VmFetchRequest, allowPrivate = false): string {
  return JSON.stringify({
    url: request.url,
    httpFallback: request.httpFallback,
    acceptLanguage: request.acceptLanguage,
    userAgent: FETCH_USER_AGENT,
    blocked: BLOCKED_SUBNETS,
    allowPrivate,
    maxBytes: FETCH_MAX_BYTES,
    maxRedirects: FETCH_MAX_REDIRECTS,
    timeoutMs: FETCH_TIMEOUT_MS,
  })
}

const FAILURES: Record<string, string> = {
  blocked_address: 'web_fetch reads public sites only; for local addresses use bash (curl) or your browser.',
  timeout: `the site did not answer within ${FETCH_TIMEOUT_MS / 1000}s`,
  dns: 'host not found',
  too_many_redirects: `more than ${FETCH_MAX_REDIRECTS} redirects`,
}

/** The script's output line as a result, or the failure it reports as a `DaemonError` the bot can act on. */
export function parseFetchOutput(stdout: string, stderr: string): VmFetchResult {
  const line = stdout.trim().split('\n').pop() ?? ''
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    const reason = /node: (command )?not found/i.test(stderr) ? 'node is missing in the VM' : stderr.trim()
    throw new DaemonError('internal', `Could not fetch the page${reason ? `: ${reason.slice(0, 300)}` : ''}`)
  }
  if (parsed.ok !== true) {
    const code = String(parsed.code ?? 'connect')
    const message = FAILURES[code] ?? String(parsed.message ?? 'failed')
    throw new DaemonError('validation_failed', `Could not fetch the page (${code}): ${message}`)
  }
  return {
    status: Number(parsed.status),
    url: String(parsed.url),
    redirects: Array.isArray(parsed.redirects) ? parsed.redirects.map(String) : [],
    contentType: typeof parsed.contentType === 'string' ? parsed.contentType : null,
    charset: typeof parsed.charset === 'string' ? parsed.charset : null,
    truncated: parsed.truncated === true,
    body: gunzipSync(Buffer.from(String(parsed.bodyGz ?? ''), 'base64')),
  }
}

/** Downloads `request.url` inside the VM as the bot (its network slice and user). */
export async function fetchInVm(
  guest: GuestClient,
  bot: Bot,
  request: VmFetchRequest,
  signal: AbortSignal,
): Promise<VmFetchResult> {
  const result = await guest.exec(
    {
      user: botLinuxUser(bot.slug),
      argv: ['node', '-e', FETCH_SCRIPT],
      cwd: '/',
      stdin: fetchScriptInput(request),
      timeoutMs: FETCH_EXEC_TIMEOUT_MS,
      maxOutputBytes: FETCH_EXEC_MAX_OUTPUT,
      bot: bot.slug,
    },
    signal,
  )
  if (result.timedOut) throw new DaemonError('validation_failed', 'Could not fetch the page (timeout)')
  return parseFetchOutput(result.stdout, result.stderr)
}
