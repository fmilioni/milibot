import { beforeEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn((_url: string) => Promise.resolve())

vi.mock('electron', () => ({ app: {}, clipboard: {}, dialog: {}, shell: { openExternal } }))

const { fileInvokes } = await import('./files')

const { openExternal: handler } = fileInvokes({} as never)
const open = (url: string) => handler({} as never, [url])

beforeEach(() => openExternal.mockClear())

describe('openExternal', () => {
  it('opens http and https URLs in the default browser', async () => {
    await open('https://a.example.com/x?y=1')
    await open('http://a.example.com')
    expect(openExternal.mock.calls).toEqual([['https://a.example.com/x?y=1'], ['http://a.example.com']])
  })

  it.each(['file:///etc/passwd', 'smb://host/share', 'javascript:alert(1)', 'milibot://x', 'not a url'])(
    'refuses %s without opening anything',
    async (url) => {
      await expect(open(url)).rejects.toThrow('URL not allowed')
      expect(openExternal).not.toHaveBeenCalled()
    },
  )
})
