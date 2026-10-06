import type { Bot, ConfirmationPayload } from '@milibot/shared'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConfirmationCard } from './ConfirmationCard'

const card = (action: string, status: ConfirmationPayload['status']): ConfirmationPayload => ({
  type: 'confirmation',
  confirmationId: 'cnf_1',
  action,
  description: '',
  status,
  params: { serverName: 'Notion' },
})

describe('ConfirmationCard', () => {
  it('words the MCP cards for what they ask instead of "keep"', () => {
    const { unmount } = render(
      <ConfirmationCard
        payload={card('mcp_add', 'pending')}
        author={undefined}
        onResolve={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
    unmount()

    const statuses: Array<[string, ConfirmationPayload['status'], string]> = [
      ['mcp_add', 'rejected', 'You declined'],
      ['mcp_add', 'approved', 'You added it'],
      ['mcp_update', 'rejected', 'You declined'],
      ['mcp_remove', 'rejected', 'You kept it'],
    ]
    for (const [action, status, label] of statuses) {
      const view = render(<ConfirmationCard payload={card(action, status)} author={undefined} />)
      expect(screen.getByText(label)).toBeTruthy()
      view.unmount()
    }
  })

  it('shows what a skill import brings, warns about scripts and says it unlocks no tools', () => {
    const details = JSON.stringify({
      source: { kind: 'github', repo: 'acme/skills', ref: 'main', sha: 'a1b2c3d4e5f6' },
      skills: [
        {
          name: 'pdf',
          importAs: 'pdf-2',
          description: 'PDF tools.',
          files: 2,
          bytes: 2048,
          conflict: 'name_taken',
          hasScripts: true,
          declaredTools: ['team'],
        },
      ],
      bots: 'all',
      families: [],
    })
    render(
      <ConfirmationCard
        payload={{
          ...card('skill_import', 'pending'),
          params: { botId: 'bot_1', botName: 'Ana', source: 'acme/skills@a1b2c3d', details },
        }}
        author={undefined}
        onResolve={() => undefined}
      />,
    )
    expect(screen.getByText(/wants to import skills from acme\/skills@a1b2c3d/)).toBeTruthy()
    expect(screen.getByText('acme/skills at commit a1b2c3d (main)')).toBeTruthy()
    expect(screen.getByText('All bots')).toBeTruthy()
    expect(screen.getByText('none')).toBeTruthy()
    expect(screen.getByText(/2 files · 2 KB · comes in as pdf-2/)).toBeTruthy()
    expect(screen.getByText('Has scripts the bots can run in the VM')).toBeTruthy()
    expect(screen.getByText(/asks for team, but imported skills never unlock tools/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Import' }).className).toMatch(/danger/)
  })

  it('reads "its own" when a bot changes its own skills or MCP servers, with what each unlocks', () => {
    const author = {
      id: 'bot_1',
      name: 'Ana',
      avatar: { shape: 'square', color: 'green', eyes: 'capsule' },
    } as Bot
    const skills = JSON.stringify({
      changes: [{ skill: 'routines', on: true, families: ['routines'], tools: 4, allow: true }],
    })
    const view = render(
      <ConfirmationCard
        payload={{
          ...card('bot_skills', 'pending'),
          params: { botId: 'bot_1', botName: 'Ana', details: skills },
        }}
        author={author}
        onResolve={() => undefined}
      />,
    )
    expect(screen.getByText('Ana wants to change its own skills')).toBeTruthy()
    expect(screen.getByText('Unlocks routines (4 tools)')).toBeTruthy()
    expect(screen.getByText('Also gives Ana access to the skill')).toBeTruthy()
    view.unmount()

    const mcp = JSON.stringify({
      changes: [{ server: 'Tracker', on: false, tools: ['create_issue'], allow: false }],
    })
    render(
      <ConfirmationCard
        payload={{
          ...card('bot_mcp', 'approved'),
          params: { botId: 'bot_2', botName: 'Iris', details: mcp },
        }}
        author={author}
      />,
    )
    expect(screen.getByText('Ana wants to change the MCP servers of Iris')).toBeTruthy()
    expect(screen.getByText('Tracker')).toBeTruthy()
    expect(screen.getByText('1 tool: create_issue')).toBeTruthy()
    expect(screen.getByText('You applied it')).toBeTruthy()
  })
})
