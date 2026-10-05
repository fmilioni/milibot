import { type Bot, type ConfirmationPayload, randomAvatar } from '@milibot/shared'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConfirmationCard } from './ConfirmationCard'
import { parseSettingChanges } from './SettingsCards'

const payload: ConfirmationPayload = {
  type: 'confirmation',
  confirmationId: 'cnf_1',
  action: 'workspace_settings',
  description: 'Keep costs in check',
  status: 'pending',
  params: {
    botId: 'bot_1',
    botName: 'Ana',
    changes: JSON.stringify([
      { field: 'spendWarnUsd', from: null, to: 5 },
      { field: 'autoMergePrs', from: false, to: true },
      { field: 'promptUpdates', from: 'approval', to: 'auto' },
    ]),
  },
}

describe('workspace settings confirmation', () => {
  it('shows each field with its current and proposed value', () => {
    render(
      <ConfirmationCard
        payload={payload}
        author={{ id: 'bot_1', name: 'Ana', avatar: randomAvatar(() => 0.5) } as Bot}
        onResolve={() => undefined}
      />,
    )
    expect(screen.getByText('Ana wants to change workspace settings')).toBeTruthy()
    expect(screen.getByText("Warn when today's spend passes")).toBeTruthy()
    expect(screen.getByText('No limit')).toBeTruthy()
    expect(screen.getByText('$5.00 a day')).toBeTruthy()
    expect(screen.getByText('Bots may merge their own pull requests')).toBeTruthy()
    expect(screen.getByText('Off')).toBeTruthy()
    expect(screen.getByText('On')).toBeTruthy()
    expect(screen.getByText('Ask for my approval')).toBeTruthy()
    expect(screen.getByText('Automatic, with a note')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
  })

  it('ignores a malformed list', () => {
    expect(parseSettingChanges('not json')).toEqual([])
    expect(parseSettingChanges('[{"to": 1}, {"field": "draftPrs", "from": true, "to": false}]')).toEqual([
      { field: 'draftPrs', from: true, to: false },
    ])
  })
})
