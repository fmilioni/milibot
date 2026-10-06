import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../src/renderer/src')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// Stage removes an outline after CHANGE_FLASH_MS, so a longer animation would be cut and a shorter one
// would leave it invisible on screen.
it('times the change outline like its CSS animation', () => {
  const ms = /export const CHANGE_FLASH_MS = (\d+)/.exec(read('features/canvas/lib/change-flash.ts'))?.[1]
  expect(ms).toBeDefined()
  expect(read('styles.css')).toContain(`animation: canvas-change-flash ${ms}ms`)
})
