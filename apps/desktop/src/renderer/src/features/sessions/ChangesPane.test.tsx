import type { SessionChangedFile, SessionChanges, SessionFileDiff } from '@milibot/shared'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

const daemon = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/api/daemon', () => ({ api: () => ({ call: daemon.call }) }))

// The real viewer is virtualized (nothing to measure in happy-dom): this one shows the patch and counts mounts,
// so a test sees whether an update replaced the open diff instead of updating it.
const viewer = vi.hoisted(() => ({ mounts: 0 }))
vi.mock('@/ui/diff/DiffViewer', () => ({
  DiffViewer: ({ patch, mode }: { patch: string; mode: string }) => {
    useEffect(() => {
      viewer.mounts++
    }, [])
    return (
      <pre data-testid="diff" data-mode={mode}>
        {patch}
      </pre>
    )
  },
}))

import { ChangesPane } from './ChangesPane'
import { useSessionStore } from './store'

const SESSION = 'wses_1'

const file = (path: string, additions = 1): SessionChangedFile => ({
  path,
  status: 'modified',
  additions,
  deletions: 0,
  binary: false,
})

const changesOf = (files: SessionChangedFile[]): SessionChanges => ({
  available: true,
  base: 'abc',
  files,
  totals: {
    files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: 0,
  },
  computedAt: 1,
})

const diffOf = (path: string, patch: string): SessionFileDiff => ({
  path,
  status: 'modified',
  binary: false,
  patch,
  truncated: false,
})

/** What the fake daemon answers; a function can hold an answer back or fail. */
let changes: () => Promise<SessionChanges>
let diffs: Record<string, () => Promise<SessionFileDiff>>

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined
  let reject: (err: Error) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const filesChanged = () =>
  act(() => {
    useSessionStore.getState().applyEvent('ws_1', {
      type: 'work_session.files_changed',
      payload: { sessionId: SESSION, totals: { files: 0, additions: 0, deletions: 0 } },
    })
  })

const spinner = () => screen.queryByRole('status')

beforeEach(() => {
  viewer.mounts = 0
  localStorage.clear()
  useAppStore.setState({ workspaceId: 'ws_1' })
  useSessionStore.setState({
    workspaceId: 'ws_1',
    changes: {},
    changesVersion: {},
    fileDiffs: {},
    fileImages: {},
    watching: null,
  })
  const many = Array.from({ length: 8 }, (_, i) => file(`src/file${i}.ts`))
  changes = () => Promise.resolve(changesOf(many))
  diffs = { 'src/file1.ts': () => Promise.resolve(diffOf('src/file1.ts', 'old patch')) }
  daemon.call.mockReset()
  daemon.call.mockImplementation((endpoint: string, input: { query?: { path: string } }) => {
    if (endpoint === 'getWorkSessionChanges') return changes()
    if (endpoint === 'getWorkSessionFileDiff') {
      const answer = diffs[input.query?.path ?? '']
      return answer ? answer() : Promise.reject(new Error('unknown file'))
    }
    return Promise.reject(new Error(`unexpected ${endpoint}`))
  })
})

describe('ChangesPane', () => {
  it('keeps the open file, its diff, the filter and the mode when the session changes files', async () => {
    render(<ChangesPane sessionId={SESSION} />)
    fireEvent.click(await screen.findByRole('button', { name: /file1\.ts/ }))
    expect((await screen.findByTestId('diff')).textContent).toBe('old patch')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'file1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unified' }))

    // The session edits the open file and drops the others: the list shrinks under the filter's threshold.
    const list = deferred<SessionChanges>()
    const patch = deferred<SessionFileDiff>()
    changes = () => list.promise
    diffs['src/file1.ts'] = () => patch.promise
    filesChanged()

    // While both reload, what was on screen stays there.
    expect(spinner()).toBeNull()
    expect(screen.getByTestId('diff').textContent).toBe('old patch')
    await act(async () => list.resolve(changesOf([file('src/file1.ts', 5), file('src/new.ts')])))
    await act(async () => patch.resolve(diffOf('src/file1.ts', 'new patch')))

    expect(screen.getByTestId('diff').textContent).toBe('new patch')
    expect(viewer.mounts).toBe(1)
    expect(spinner()).toBeNull()
    expect(screen.getByRole('button', { name: /file1\.ts/ }).getAttribute('aria-expanded')).toBe('true')
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('file1')
    expect(screen.queryByRole('button', { name: /new\.ts/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Unified' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('+5')).toBeTruthy()
  })

  it('follows the session in a card (not the session on screen), reopened several times, without a spinner', async () => {
    const scroller = document.createElement('div')
    const first = render(<ChangesPane sessionId={SESSION} scrollParent={scroller} />)
    expect(await screen.findByText('8 files')).toBeTruthy()

    changes = () => Promise.resolve(changesOf([file('src/a.ts'), file('src/b.ts')]))
    filesChanged()
    expect(spinner()).toBeNull()
    expect(await screen.findByText('2 files')).toBeTruthy()
    first.unmount()

    // Changed while closed: reopening shows what it had and reloads over it.
    const later = deferred<SessionChanges>()
    changes = () => later.promise
    filesChanged()
    for (let i = 0; i < 3; i++) {
      const again = render(<ChangesPane sessionId={SESSION} scrollParent={scroller} />)
      expect(spinner()).toBeNull()
      expect(screen.getByText('2 files')).toBeTruthy()
      again.unmount()
    }
    render(<ChangesPane sessionId={SESSION} scrollParent={scroller} />)
    await act(async () => later.resolve(changesOf([file('src/a.ts')])))
    expect(screen.getByText('1 file')).toBeTruthy()
    expect(spinner()).toBeNull()
  })

  it('shows the error instead of a spinner, and keeps the list when only the reload failed', async () => {
    changes = () => Promise.reject(new Error('vm down'))
    const view = render(<ChangesPane sessionId={SESSION} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read the changes')
    expect(spinner()).toBeNull()

    changes = () => Promise.resolve(changesOf([file('src/a.ts')]))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('1 file')).toBeTruthy()

    changes = () => Promise.reject(new Error('vm down'))
    filesChanged()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('1 file')).toBeTruthy()
    view.unmount()
  })

  it('keeps the newest answer when an older one arrives after it', async () => {
    const slow = deferred<SessionChanges>()
    changes = () => slow.promise
    render(<ChangesPane sessionId={SESSION} />)
    changes = () => Promise.resolve(changesOf([file('src/newest.ts')]))
    filesChanged()
    expect(await screen.findByText('1 file')).toBeTruthy()
    await act(async () => slow.resolve(changesOf([file('src/a.ts'), file('src/b.ts')])))
    expect(screen.getByText('1 file')).toBeTruthy()
  })

  it("says a changed image is no longer available once the session's folder is gone, without a retry", async () => {
    const shot: SessionChangedFile = { ...file('src/shot.png'), binary: true }
    changes = () => Promise.resolve(changesOf([shot]))
    diffs['src/shot.png'] = () => Promise.resolve({ ...diffOf('src/shot.png', ''), binary: true })
    const fallback = daemon.call.getMockImplementation()
    daemon.call.mockImplementation((endpoint: string, input: unknown) =>
      endpoint === 'getWorkSessionFileImages'
        ? Promise.resolve({ before: null, after: null, unavailable: true })
        : fallback?.(endpoint, input),
    )
    render(<ChangesPane sessionId={SESSION} />)
    fireEvent.click(await screen.findByRole('button', { name: /shot\.png/ }))

    expect(await screen.findByText(/The image is no longer available/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})
