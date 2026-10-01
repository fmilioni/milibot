import { describe, expect, it } from 'vitest'

import { commandRunner, shellQuote } from './exec'

describe('exec helpers', () => {
  it('quotes one shell argument', () => {
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`)
  })

  it('reports the exit code and stdout, and never rejects', async () => {
    const node = commandRunner(process.execPath)
    await expect(node(['-e', 'process.stdout.write("hi"); process.exit(3)'])).resolves.toEqual({
      code: 3,
      stdout: 'hi',
    })
    await expect(commandRunner('/nonexistent/command')([])).resolves.toMatchObject({ code: 1 })
  })
})
