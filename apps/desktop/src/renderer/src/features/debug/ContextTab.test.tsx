import type { Bot, ConversationDebug, InstructionFileInfo } from '@milibot/shared'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/bots/api', () => ({ useBotMemories: () => ({ data: [], error: null }) }))
vi.mock('./api', () => ({ useConversationSummaries: () => ({ data: [] }) }))

import { ContextTab } from './ContextTab'

const bot = { id: 'bot_1', name: 'Theo' } as Bot

function show(instructionFiles: InstructionFileInfo[]) {
  const debug = {
    latestComposition: [
      {
        llmCallId: 'llm_1',
        botId: bot.id,
        model: 'gpt-6',
        createdAt: 0,
        composition: {
          systemPrompt: 100,
          longTermMemory: 0,
          summaries: 0,
          retrieved: 0,
          recentTail: 50,
          tools: 10,
        },
        instructionFiles,
      },
    ],
  } as unknown as ConversationDebug
  return render(
    <ContextTab
      data={{ debug, calls: [] }}
      bots={{ [bot.id]: bot }}
      conversationId="cnv_1"
      members={[bot]}
    />,
  )
}

describe('ContextTab', () => {
  it('lists the instruction files of the latest call with their size, origin and cut', () => {
    show([
      { path: '/workspace/app/CLAUDE.md', bytes: 2048, truncated: false, source: 'engine' },
      { path: '/workspace/app/apps/AGENTS.md', bytes: 120_000, truncated: true, source: 'injected' },
    ])
    expect(screen.getByRole('heading', { name: 'Repository instruction files (2)' })).toBeTruthy()
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('/workspace/app'))
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^\/workspace\/app\/CLAUDE\.mdread by the CLI2(\.0)? KB$/),
      expect.stringMatching(/^\/workspace\/app\/apps\/AGENTS\.mdtruncated1\d{2}(\.\d)? KB$/),
    ])
  })

  it('says when no instruction file entered the context', () => {
    show([])
    expect(screen.getByText('No CLAUDE.md or AGENTS.md entered the context.')).toBeTruthy()
  })
})
