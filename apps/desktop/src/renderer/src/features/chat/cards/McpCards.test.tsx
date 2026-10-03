import type { McpSignInPayload } from '@milibot/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { McpChangeDetails, McpSignInCard } from './McpCards'

const signIn = (patch: Partial<McpSignInPayload> = {}): McpSignInPayload => ({
  type: 'mcp_sign_in',
  serverId: 'mcp_1',
  serverName: 'Notion',
  botId: 'bot_1',
  authorizationUrl: 'https://auth.example.com/authorize?state=x',
  status: 'pending',
  ...patch,
})

describe('McpChangeDetails', () => {
  it('shows what changes with secret references masked', () => {
    render(
      <McpChangeDetails
        details={JSON.stringify({
          transport: 'http',
          target: 'https://mcp.example.com',
          headers: [{ name: 'Authorization', value: 'Bearer {{secret:NOTION_TOKEN}}' }, { name: 'X-Kept' }],
          bots: 'all',
        })}
      />,
    )
    expect(screen.getByText('https://mcp.example.com')).toBeTruthy()
    expect(
      screen.getByText(/Authorization: Bearer •••• \(secret NOTION_TOKEN\)\s+X-Kept: keeps the saved value/),
    ).toBeTruthy()
    expect(screen.getByText('All bots')).toBeTruthy()
    expect(document.body.textContent).not.toContain('{{secret:')
  })

  it('renders nothing for unreadable details', () => {
    const { container } = render(<McpChangeDetails details="{not json" />)
    expect(container.textContent).toBe('')
  })
})

describe('McpSignInCard', () => {
  it('opens the sign-in in the system browser while it waits', () => {
    const openExternal = vi.fn(() => Promise.resolve())
    Object.assign(window, { milibot: { openExternal } })
    render(<McpSignInCard payload={signIn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.com/authorize?state=x')
  })

  it('shows the outcome without the button', () => {
    render(<McpSignInCard payload={signIn({ status: 'connected', account: 'ana@example.com' })} />)
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('Connected as ana@example.com')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
