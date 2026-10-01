import { describe, expect, it } from 'vitest'

import { allowedBotNames, joinCommandLine, serverDetail, serverIconKind, splitCommandLine } from './mcp'

describe('command lines', () => {
  it('splits like a shell, without expansions', () => {
    expect(splitCommandLine('npx -y @modelcontextprotocol/server-filesystem /workspace')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/workspace',
    ])
    expect(splitCommandLine(`uvx mcp-server "my dir" 'a b' c\\ d ""`)).toEqual([
      'uvx',
      'mcp-server',
      'my dir',
      'a b',
      'c d',
      '',
    ])
    expect(splitCommandLine('  echo $HOME  ')).toEqual(['echo', '$HOME'])
  })

  it('joins back with the minimum quoting', () => {
    const words = ['uvx', 'mcp-server', 'my dir', "it's", '--flag=x']
    expect(joinCommandLine(words)).toBe(`uvx mcp-server 'my dir' 'it'\\''s' --flag=x`)
    expect(splitCommandLine(joinCommandLine(words))).toEqual(words)
  })

  it('describes a server by its command or URL', () => {
    expect(serverDetail({ transport: 'stdio_vm', command: 'npx', args: ['-y', 'pkg'], url: null })).toBe(
      'npx -y pkg',
    )
    expect(serverDetail({ transport: 'http', command: null, args: [], url: 'https://x.dev/mcp' })).toBe(
      'https://x.dev/mcp',
    )
  })
})

describe('server list helpers', () => {
  it('names the allowed bots, skipping deleted ones', () => {
    const bots = { a: { name: 'Dex' }, b: { name: 'Watcher' } } as never
    expect(allowedBotNames('all', bots)).toBe('all')
    expect(allowedBotNames(['a', 'gone', 'b'], bots)).toEqual(['Dex', 'Watcher'])
  })

  it('picks an icon from the server', () => {
    const base = { transport: 'stdio_vm' as const, command: 'npx', args: [], url: null }
    expect(serverIconKind({ ...base, name: 'GitHub' })).toBe('github')
    expect(serverIconKind({ ...base, name: 'Postgres (dev)' })).toBe('database')
    expect(serverIconKind({ ...base, name: 'Everything' })).toBe('terminal')
    expect(
      serverIconKind({ ...base, transport: 'http', name: 'Notion', url: 'https://mcp.notion.com/mcp' }),
    ).toBe('globe')
  })
})
