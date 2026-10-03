import { CLI_ENGINE_INFO, CLI_ENGINES, type CliEngine, type Provider } from '@milibot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { CliProviderCard } from './CliProviderCard'

const getCliInstall = vi.fn()
const getCliLoginStatus = vi.fn()

vi.mock('@/features/providers/api', () => ({
  getCliInstall: (...args: unknown[]) => getCliInstall(...args),
  getCliLoginStatus: (...args: unknown[]) => getCliLoginStatus(...args),
  installCli: vi.fn(),
  checkProvider: vi.fn(),
  openCliLoginTerminal: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
}))

const provider = (engine: CliEngine): Provider =>
  ({
    id: `prv_${engine}`,
    type: engine,
    name: CLI_ENGINE_INFO[engine].displayName,
    authMode: 'subscription',
    baseUrl: null,
    hasSecret: false,
    isDefault: false,
  }) as Provider

function show(engine: CliEngine) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CliProviderCard provider={provider(engine)} engine={engine} onChanged={() => {}} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getCliInstall.mockReset()
  getCliInstall.mockResolvedValue({ version: null, expected: '1.0.0', installing: false, error: null })
  getCliLoginStatus.mockReset()
  getCliLoginStatus.mockResolvedValue({ loggedIn: null, terminalOpen: null, loggedInElsewhere: false })
  useAppStore.setState({ workspaceId: 'ws_1', vm: { state: 'running' } as never, bots: {}, cliUsage: {} })
})

describe('CliProviderCard', () => {
  it.each(CLI_ENGINES)('words the %s card from its engine info', async (engine) => {
    const info = CLI_ENGINE_INFO[engine]
    show(engine)
    expect(
      await screen.findByText(`Sign in once in the VM's terminal with your ${info.account} account`, {
        exact: false,
      }),
    ).toBeTruthy()
    if (info.authModes.length > 1)
      expect(screen.getByRole('radio', { name: `${info.account} account` })).toBeTruthy()
    else expect(screen.queryByRole('radio')).toBeNull()
    if (info.needsInstall) {
      expect(await screen.findByText(`${info.displayName} is not installed in the VM yet`)).toBeTruthy()
      expect(getCliInstall).toHaveBeenCalledWith('ws_1', engine)
    } else {
      expect(getCliInstall).not.toHaveBeenCalled()
    }
    if (!info.authModes.includes('api_key')) return
    fireEvent.click(screen.getByRole('radio', { name: 'API key' }))
    expect(screen.getByText(`${info.vendor} API key`)).toBeTruthy()
    expect(screen.getByPlaceholderText(info.keyPlaceholder)).toBeTruthy()
  })

  describe('sign-in status', () => {
    const login = (loggedIn: boolean | null) => ({ loggedIn, terminalOpen: false, loggedInElsewhere: false })

    it('asks the VM when shown and reports a signed-in engine without a stored plan', async () => {
      getCliLoginStatus.mockResolvedValue(login(true))
      show('antigravity')
      expect(await screen.findByText('Connected with your', { exact: false })).toBeTruthy()
      expect(getCliLoginStatus).toHaveBeenCalledWith('ws_1', 'antigravity')
    })

    it('reports an engine that is not signed in', async () => {
      getCliLoginStatus.mockResolvedValue(login(false))
      show('codex')
      expect(await screen.findByText('is not signed in inside the VM yet', { exact: false })).toBeTruthy()
    })

    it('shows the check in progress while the VM answers', () => {
      getCliLoginStatus.mockReturnValue(new Promise(() => {}))
      show('claude_code')
      expect(screen.getByText('Checking…')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Check' })).toHaveProperty('disabled', true)
    })

    it('does not ask while the VM is off', () => {
      useAppStore.setState({ vm: { state: 'stopped' } as never })
      show('claude_code')
      expect(getCliLoginStatus).not.toHaveBeenCalled()
    })
  })
})
