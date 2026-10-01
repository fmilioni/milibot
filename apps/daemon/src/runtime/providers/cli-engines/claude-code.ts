import { ANTHROPIC_PRICES, anthropicPrices, type DiscoveredModel } from '@milibot/agent/llm'
import { CLI_ENGINE_INFO, cliModelInfo } from '@milibot/shared'

import { botLinuxUser, type GuestClient } from '../../vm'
import type { CliEngineHost } from './host'

/** `loggedIn` of `claude auth status --json`; null when the output is not that JSON. */
export function parseClaudeLoggedIn(stdout: string): boolean | null {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { loggedIn?: unknown }
    return typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : null
  } catch {
    return null
  }
}

/**
 * Plan from `claude auth status --json` (`subscriptionType`). Only that field is kept: the output
 * also carries the account e-mail and organization, which never leave this function.
 */
export function parseClaudeAuthStatus(stdout: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { loggedIn, subscriptionType } = parsed as { loggedIn?: unknown; subscriptionType?: unknown }
  if (loggedIn === false || typeof subscriptionType !== 'string') return null
  const plan = subscriptionType.trim().toLowerCase()
  return /^[a-z0-9_-]{1,32}$/.test(plan) ? plan : null
}

const AGENT_LOGIN_STATUS_CMD = 'claude auth status --json'

/**
 * The bot user's own login (its `~/.claude`), not agent's: `claude` in the VM is a wrapper that switches to
 * agent, so this calls the binary behind it (plain `claude` on images from before the wrapper).
 */
const BOT_LOGIN_STATUS_CMD =
  'r=/usr/local/lib/milibot/claude-real; [ -x "$r" ] || r=claude; "$r" auth status --json'

/**
 * Whether Claude Code was logged in from a bot's own terminal instead of the agent account the bots use.
 * Only `loggedIn` is read from the CLI output.
 */
export async function loggedInAsBotUser(guest: Pick<GuestClient, 'exec'>, slugs: string[]): Promise<boolean> {
  for (const slug of slugs) {
    try {
      const result = await guest.exec({
        user: botLinuxUser(slug),
        cmd: BOT_LOGIN_STATUS_CMD,
        timeoutMs: 20_000,
      })
      if (parseClaudeLoggedIn(result.stdout) === true) return true
    } catch {
      // A bot whose Linux user is not provisioned yet has no login of its own.
    }
  }
  return false
}

/** Anthropic's catalog with its prices (Claude Code runs Anthropic's models). */
function claudeCodeCatalog(): DiscoveredModel[] {
  return Object.entries(ANTHROPIC_PRICES).map(([modelId, info]) => {
    const prices = anthropicPrices(modelId)
    return {
      kind: 'chat' as const,
      modelId,
      displayName: info.displayName,
      supportsTools: true,
      supportsVision: true,
      contextWindow: info.contextWindow,
      maxOutputTokens: info.maxOutputTokens,
      efforts: info.efforts,
      defaultEffort: null,
      dimensions: null,
      priceInputPerMtokUsd: prices?.priceInputPerMtokUsd ?? null,
      priceOutputPerMtokUsd: prices?.priceOutputPerMtokUsd ?? null,
      priceCacheReadPerMtokUsd: prices?.priceCacheReadPerMtokUsd ?? null,
      priceCacheWritePerMtokUsd: prices?.priceCacheWritePerMtokUsd ?? null,
      pricePerRequestUsd: null,
      enabled: true,
      source: 'builtin' as const,
    }
  })
}

const INFO = CLI_ENGINE_INFO.claude_code

export const claudeCodeHost: CliEngineHost = {
  engine: 'claude_code',
  defaultModel: INFO.defaultModel,
  models: INFO.models,
  catalogModels: claudeCodeCatalog,
  lightModel: () => INFO.lightModel,
  efforts: (model) => cliModelInfo('claude_code', model)?.efforts ?? null,
  signIn(mode, secret, baseUrl) {
    const env: Record<string, string> = {}
    if (mode === 'api_key' && secret) env.ANTHROPIC_API_KEY = secret
    if (mode === 'auth_token' && secret) env.ANTHROPIC_AUTH_TOKEN = secret
    if (mode !== 'subscription' && baseUrl) env.ANTHROPIC_BASE_URL = baseUrl
    return { env }
  },
  login: { title: INFO.displayName, command: 'claude; exec bash', name: 'claude' },
  loggedIn: async (guest) =>
    parseClaudeLoggedIn(
      (await guest.exec({ user: 'agent', cmd: AGENT_LOGIN_STATUS_CMD, timeoutMs: 20_000 })).stdout,
    ),
  loggedInElsewhere: loggedInAsBotUser,
  plan: { command: AGENT_LOGIN_STATUS_CMD, parse: parseClaudeAuthStatus },
  async test(guest, provider) {
    const result = await guest.exec({
      user: 'agent',
      cmd: 'claude --version && { test -f "$HOME/.claude/.credentials.json" && echo LOGGED_IN || echo NOT_LOGGED_IN; }',
      timeoutMs: 30_000,
    })
    const loggedIn = result.stdout.includes('LOGGED_IN') && !result.stdout.includes('NOT_LOGGED_IN')
    const needsLogin = provider.authMode === 'subscription' && !loggedIn
    return {
      ok: result.code === 0 && !needsLogin,
      error:
        result.code !== 0
          ? result.stderr.trim() || 'claude is not available in the VM'
          : needsLogin
            ? 'Claude Code is not logged in inside the VM'
            : null,
    }
  },
  createRuntime: () => ({ name: 'claude-code' }),
}
