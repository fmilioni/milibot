import type { McpServer } from '@milibot/shared'
import { Database, Globe, SquareTerminal } from 'lucide-react'

import { serverIconKind } from '@/features/mcp/lib/mcp'
import { GithubMark } from '@/features/skills/SkillParts'

export function ServerIcon({
  server,
  size = 16,
}: {
  server: Pick<McpServer, 'name' | 'transport' | 'command' | 'args' | 'url'>
  size?: number
}) {
  switch (serverIconKind(server)) {
    case 'github':
      return <GithubMark size={size} />
    case 'database':
      return <Database size={size} aria-hidden />
    case 'globe':
      return <Globe size={size} aria-hidden />
    default:
      return <SquareTerminal size={size} aria-hidden />
  }
}
