import type { ConfirmationPayload } from '@milibot/shared'
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
})
