import { describe, expect, it } from 'vitest'

import { claudeCodeMcpConfig } from '../claude-code/mcp'
import { claudeCodeProfile } from '../claude-code/profile'
import { ClaudeCodeSessions } from '../claude-code/sessions'
import { describeToolCall } from '../tools/describe'
import type { McpServerConfig, McpToolInfo } from './config'
import { mcpServerSlug, mcpToolName, parseMcpToolName } from './names'
import { type BotMcpServerView, botMcpToolSet, urlForGuest } from './tools'

const stdioConfig = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'mcp_1',
  slug: 'test',
  name: 'Test',
  transport: 'stdio_vm',
  command: 'npx',
  args: ['-y', 'test-server'],
  url: null,
  env: { API_TOKEN: 'super-secret-token' },
  headers: {},
  enabled: true,
  ...overrides,
})

describe('names', () => {
  it('derives slugs that split unambiguously', () => {
    expect(mcpServerSlug('GitHub')).toBe('github')
    expect(mcpServerSlug('Postgres (dev)')).toBe('postgres_dev')
    expect(mcpServerSlug('Crème  Brûlée!!')).toBe('creme_brulee')
    expect(mcpServerSlug('***')).toBe('server')
  })

  it('namespaces tools as mcp__<server>__<tool> and parses them back', () => {
    expect(mcpToolName('github', 'create_pull_request')).toBe('mcp__github__create_pull_request')
    expect(mcpToolName('pg_dev', 'db.query')).toBe('mcp__pg_dev__db_query')
    expect(parseMcpToolName('mcp__pg_dev__db_query')).toEqual({ server: 'pg_dev', tool: 'db_query' })
    expect(parseMcpToolName('computer')).toBeNull()
    const long = mcpToolName('github', 'x'.repeat(80))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).not.toBe(mcpToolName('github', `${'x'.repeat(79)}y`))
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('describes external tool calls as "Server · tool"', () => {
    expect(
      describeToolCall('mcp__github__create_pull_request', {}, { mcpServerName: () => 'GitHub' }),
    ).toEqual({
      kind: 'mcp',
      detail: 'GitHub · create_pull_request',
    })
    expect(describeToolCall('mcp__github__list_issues', {})).toEqual({
      kind: 'mcp',
      detail: 'github · list_issues',
    })
  })
})

const tool = (name: string, description = `${name} tool`): McpToolInfo => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
})

function view(
  overrides: Partial<Omit<BotMcpServerView, 'config'>> & { config?: Partial<McpServerConfig> } = {},
): BotMcpServerView {
  return {
    tools: [tool('create_pull_request'), tool('list_issues'), tool('delete_branch')],
    disabledTools: new Set(['delete_branch']),
    httpKind: null,
    revision: 1,
    ...overrides,
    config: stdioConfig({ id: 'mcp_gh', slug: 'github', name: 'GitHub', ...overrides.config }),
  }
}

describe('per-bot tool sets', () => {
  it('exposes only the enabled tools, namespaced, with tokens per server', () => {
    const set = botMcpToolSet([
      view(),
      view({
        config: { id: 'mcp_pg', slug: 'pg', name: 'Postgres' },
        tools: [tool('query')],
        disabledTools: new Set(),
      }),
    ])
    expect(set.tools.map((t) => t.name)).toEqual([
      'mcp__github__create_pull_request',
      'mcp__github__list_issues',
      'mcp__pg__query',
    ])
    expect(set.index.get('mcp__pg__query')).toEqual({
      serverId: 'mcp_pg',
      serverName: 'Postgres',
      tool: 'query',
    })
    expect(set.index.has('mcp__github__delete_branch')).toBe(false)
    expect(Object.keys(set.tokensByServer)).toEqual(['GitHub', 'Postgres'])
    expect(set.tokensByServer.GitHub).toBeGreaterThan(set.tokensByServer.Postgres as number)
  })
})

describe('Claude Code MCP config', () => {
  it('passes stdio servers as they are, HTTP ones with headers, and disables tools', () => {
    const config = claudeCodeMcpConfig(
      [
        view(),
        view({
          config: {
            id: 'mcp_notion',
            slug: 'notion',
            name: 'Notion',
            transport: 'http',
            command: null,
            args: [],
            url: 'http://localhost:8080/mcp',
            env: {},
            headers: { Authorization: 'Bearer ntn_secret_value' },
          },
          httpKind: 'sse',
          disabledTools: new Set(),
        }),
      ],
      '10.0.2.2',
    )
    expect(config.servers).toEqual({
      github: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'test-server'],
        env: { API_TOKEN: 'super-secret-token' },
      },
      notion: {
        type: 'sse',
        url: 'http://10.0.2.2:8080/mcp',
        headers: { Authorization: 'Bearer ntn_secret_value' },
      },
    })
    expect(config.disallowedTools).toEqual(['mcp__github__delete_branch'])
    expect(config.fingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(config.fingerprint).not.toContain('secret')
  })

  it('changes the fingerprint (and the session profile) when tools or config change, not when secrets are only read', () => {
    const base = claudeCodeMcpConfig([view()], '10.0.2.2').fingerprint
    expect(claudeCodeMcpConfig([view()], '10.0.2.2').fingerprint).toBe(base)
    expect(claudeCodeMcpConfig([view({ disabledTools: new Set() })], '10.0.2.2').fingerprint).not.toBe(base)
    expect(claudeCodeMcpConfig([view({ revision: 2 })], '10.0.2.2').fingerprint).not.toBe(base)
    expect(claudeCodeMcpConfig([], '10.0.2.2').fingerprint).toBe('')
    const profile = (externalFingerprint: string) =>
      claudeCodeProfile({
        settings: { rotateIdleMinutes: 55, rotateContextTokens: 60_000, systemPrompt: null },
        instructions: 'x',
        mcpTools: [],
        nativeTools: null,
        externalFingerprint,
      })
    expect(profile(base)).not.toBe(profile(''))
  })

  it('rewrites only loopback hosts for the guest', () => {
    expect(urlForGuest('http://127.0.0.1:3000/mcp', '10.0.2.2')).toBe('http://10.0.2.2:3000/mcp')
    expect(urlForGuest('https://mcp.notion.com/mcp', '10.0.2.2')).toBe('https://mcp.notion.com/mcp')
  })

  it('adds the servers to --mcp-config and the disabled tools to --disallowedTools', async () => {
    const files = new Map<string, string>()
    const sessions = new ClaudeCodeSessions({
      startProcess: async () => ({ id: 'p' }),
      events: () => ({ async *[Symbol.asyncIterator]() {} }),
      writeStdin: async () => undefined,
      signal: async () => undefined,
      writeAgentFile: async (name, content) => {
        files.set(name, content)
        return `/home/agent/.milibot/${name}`
      },
      mcpEndpoint: async () => ({ url: 'http://10.0.2.2:1234/mcp', token: 'tok' }),
      getSessionId: () => null,
      setSessionId: () => undefined,
    })
    const external = claudeCodeMcpConfig([view()], '10.0.2.2')
    const argv = await sessions.buildArgv({
      bot: { id: 'bot_1', slug: 'iris', displayNum: 2 } as never,
      model: null,
      env: {},
      idleTimeoutMs: 1000,
      instructions: 'p',
      externalMcp: external,
    })
    const written = JSON.parse(files.get('mcp-iris.json') as string) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(written.mcpServers)).toEqual(['github', 'milibot'])
    const i = argv.indexOf('--disallowedTools')
    expect(argv[i + 1]).toBe('mcp__github__delete_branch')
    expect(argv[i - 1]).toBe('--strict-mcp-config')
    // The secret only goes to the 0600 file in the VM, never to the argv (which is logged).
    expect(argv.join(' ')).not.toContain('super-secret-token')
  })
})
