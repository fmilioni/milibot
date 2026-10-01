import { describe, expect, it } from 'vitest'

import { resolveWorkspacePath } from '../../../src/runtime/code/paths'

describe('workspace paths', () => {
  it('resolves paths against the working directory, inside /workspace only', () => {
    expect(resolveWorkspacePath('src/a.ts', '/workspace/sessions/ana-1')).toBe(
      '/workspace/sessions/ana-1/src/a.ts',
    )
    expect(resolveWorkspacePath('/workspace/x', '/workspace/sessions/ana-1')).toBe('/workspace/x')
    expect(resolveWorkspacePath('../../../etc/passwd', '/workspace/sessions/ana-1')).toBeNull()
    expect(resolveWorkspacePath('a', '/home/x')).toBe('/workspace/a')
  })
})
