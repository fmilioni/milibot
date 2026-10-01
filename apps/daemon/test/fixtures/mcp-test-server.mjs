// Tiny MCP server for tests: stdio when run directly, or `buildServer()` for the HTTP transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

export function buildServer() {
  const server = new McpServer({ name: 'milibot-test', version: '1.0.0' })
  server.registerTool(
    'echo',
    { description: 'Echoes the text back', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )
  server.registerTool(
    'add',
    { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  )
  server.registerTool('whoami', { description: 'Shows the configured token' }, async () => ({
    content: [{ type: 'text', text: `token=${process.env.TEST_TOKEN ?? 'none'}` }],
  }))
  return server
}

if (process.argv[2] === 'stdio') {
  await buildServer().connect(new StdioServerTransport())
}
