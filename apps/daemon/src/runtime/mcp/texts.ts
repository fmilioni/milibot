import type { Bot, McpServer, McpTestResult } from '@milibot/shared'

import type { McpSignInOutcome } from './oauth'

const MAX_TOOL_NAMES = 30

/** "all bots" or the names of the bots a server is for. */
function botsText(server: Pick<McpServer, 'allowedBots'>, bots: Bot[]): string {
  if (server.allowedBots === 'all') return 'all bots'
  const names = server.allowedBots.map((id) => bots.find((b) => b.id === id)?.name).filter(Boolean)
  return names.length ? names.join(', ') : 'no bot'
}

function toolNames(tools: Array<{ name: string }>): string {
  const names = tools.map((t) => t.name)
  const shown = names.slice(0, MAX_TOOL_NAMES).join(', ')
  return names.length > MAX_TOOL_NAMES ? `${shown} and ${names.length - MAX_TOOL_NAMES} more` : shown
}

function availability(server: McpServer, bots: Bot[]): string {
  return (
    `Its tools reach ${botsText(server, bots)} from the next turn, named mcp__${server.slug}__<tool> ` +
    '(each bot can switch them off in its settings).'
  )
}

function target(server: McpServer): string {
  return server.transport === 'http'
    ? `remote, ${server.url ?? ''}`
    : `in the VM, ${[server.command ?? '', ...server.args].join(' ')}`
}

export function listText(servers: McpServer[], bots: Bot[], me: Bot): string {
  if (servers.length === 0) return 'The workspace has no MCP servers.'
  const lines = servers.map((s) => {
    const signIn = s.oauth
      ? s.oauth.connected
        ? `; signed in${s.oauth.account ? ` as ${s.oauth.account}` : ''}`
        : '; needs a sign-in'
      : ''
    const keys = [...s.headers, ...s.env].map((kv) => `${kv.name}${kv.secret ? ' (secret)' : ''}`)
    const mine = s.allowedBots === 'all' || s.allowedBots.includes(me.id)
    return [
      `- ${s.name} (${s.id}, slug ${s.slug}): ${target(s)}`,
      `  status: ${s.enabled ? s.state.status : 'disabled'}${s.state.error ? ` (${s.state.error})` : ''}${signIn}`,
      `  for: ${botsText(s, bots)}${mine ? '' : ' (not you)'}; tools: ${s.tools.length ? `${s.tools.length} (${toolNames(s.tools)})` : 'none listed yet'}`,
      ...(keys.length ? [`  ${s.transport === 'http' ? 'headers' : 'env'}: ${keys.join(', ')}`] : []),
    ].join('\n')
  })
  return lines.join('\n')
}

export function pendingText(seconds: number): string {
  return (
    `The user has not finished yet (waited ${Math.round(seconds / 60)} min); the card stays in the chat. ` +
    'You get a note with the outcome when they do: do not ask again.'
  )
}

export function rejectedText(kind: 'add' | 'update' | 'remove', name: string): string {
  const what = kind === 'add' ? 'adding' : kind === 'update' ? 'changing' : 'removing'
  return `The user rejected ${what} the MCP server ${name}. Nothing changed.`
}

export function goneText(kind: 'update' | 'remove', name: string): string {
  const what = kind === 'update' ? 'change' : 'removal'
  return `The MCP server ${name} no longer exists, so the ${what} the user approved was not applied. Nothing changed.`
}

export function removedText(name: string): string {
  return `Removed the MCP server ${name}; its tools are gone for every bot.`
}

export function testText(
  server: McpServer,
  result: McpTestResult,
  bots: Bot[],
  what?: 'added' | 'changed',
): string {
  const head = what ? `${what === 'added' ? 'Added' : 'Changed'} the MCP server ${server.name}. ` : ''
  if (result.ok)
    return (
      `${head}Test passed: ${result.tools.length} tools (${toolNames(result.tools)}). ` +
      availability(server, bots)
    )
  if (result.authRequired) return `${head}It needs the user to sign in (OAuth) before its tools can be used.`
  return (
    `${head}Test failed: ${result.error ?? 'unknown error'}. ` +
    'Fix it with mcp_server_update (or remove it) and test again.'
  )
}

export function unchangedConnectionText(server: McpServer, bots: Bot[]): string {
  return `Changed the MCP server ${server.name} (now for ${botsText(server, bots)}${server.enabled ? '' : ', disabled'}).`
}

export function connectedText(
  server: McpServer,
  account: string | null,
  error: string | null,
  bots: Bot[],
): string {
  const who = account ? ` as ${account}` : ''
  if (error) return `Signed in to ${server.name}${who}, but the test failed: ${error}.`
  return `Signed in to ${server.name}${who}: ${server.tools.length} tools (${toolNames(server.tools)}). ${availability(server, bots)}`
}

export function signInOutcomeText(name: string, outcome: McpSignInOutcome): string {
  switch (outcome.status) {
    case 'connected':
      return `Signed in to ${name}.`
    case 'failed':
      return `The sign-in to ${name} failed: ${outcome.error}. Offer to try again (mcp_server_connect).`
    case 'expired':
      return `The sign-in to ${name} expired before the user finished it. Call mcp_server_connect again if they still want it.`
    case 'cancelled':
      return `The sign-in to ${name} was cancelled or replaced by another one.`
  }
}

export function signInStartedText(name: string): string {
  return `Posted the sign-in card for ${name}; the user signs in from it.`
}

export function noSignInText(name: string): string {
  return `${name} runs in the VM: it has no sign-in (it takes its credentials from env).`
}
