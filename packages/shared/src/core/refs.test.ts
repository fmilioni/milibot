import { describe, expect, it } from 'vitest'

import { newId } from './ids'
import { isWorkspaceFilePath, REF_ID_PATTERN, REF_KINDS, refKindOf, WORKSPACE_PATH_PATTERN } from './refs'

const ULID = '01m41qvydqnjxef4ax623he0my'
const ids = (text: string) => [...text.matchAll(REF_ID_PATTERN)].map((m) => m[0])
const paths = (text: string) => [...text.matchAll(WORKSPACE_PATH_PATTERN)].map((m) => m[0])

describe('refs', () => {
  it('knows the kind of every linked prefix and of fresh ids', () => {
    for (const [kind, prefix] of Object.entries(REF_KINDS)) expect(refKindOf(`${prefix}_${ULID}`)).toBe(kind)
    expect(refKindOf(newId('boardCard'))).toBe('card')
    expect(refKindOf(newId('workSession'))).toBe('session')
  })

  it('leaves ids without a screen, wrong lengths and uppercase out', () => {
    expect(refKindOf(`msg_${ULID}`)).toBeNull()
    expect(refKindOf(`att_${ULID}`)).toBeNull()
    expect(refKindOf(`bcd_${ULID}x`)).toBeNull()
    expect(refKindOf(`bcd_${ULID.slice(1)}`)).toBeNull()
    expect(refKindOf(`bcd_${ULID.toUpperCase()}`)).toBeNull()
    expect(refKindOf(`bcd_01m41qvydqnjxef4ax623he0mu`)).toBeNull()
  })

  it('finds ids in running text, not tool names, slugs or glued words', () => {
    expect(ids(`Card bcd_${ULID}, board (brd_${ULID}).`)).toEqual([`bcd_${ULID}`, `brd_${ULID}`])
    expect(ids('plan_submit board_card_get bot-theo skill_load')).toEqual([])
    expect(ids(`xbcd_${ULID} bcd_${ULID}a bcd_${ULID}_x bcd_${ULID}-x`)).toEqual([])
    expect(ids(`bcd_${ULID}7`)).toEqual([])
    expect(ids(`skill_${ULID} plan_${ULID}`)).toEqual([`skill_${ULID}`, `plan_${ULID}`])
  })

  it('finds /workspace paths up to a space or quote', () => {
    expect(paths('See /workspace/milibot/design/NOTES.md now')).toEqual([
      '/workspace/milibot/design/NOTES.md',
    ])
    expect(paths('"/workspace/a.txt" and `/workspace/b.txt`')).toEqual([
      '/workspace/a.txt',
      '/workspace/b.txt',
    ])
    expect(paths('/home/agent/workspace/x ~/workspace/y /workspacefoo')).toEqual([])
  })

  it('accepts only clean file paths under /workspace', () => {
    expect(isWorkspaceFilePath('/workspace/a/b.md')).toBe(true)
    expect(isWorkspaceFilePath('/workspace/')).toBe(false)
    expect(isWorkspaceFilePath('/workspace/a/')).toBe(false)
    expect(isWorkspaceFilePath('/workspace/../etc/passwd')).toBe(false)
    expect(isWorkspaceFilePath('/workspace/a/./b')).toBe(false)
    expect(isWorkspaceFilePath('/workspace//b')).toBe(false)
    expect(isWorkspaceFilePath('/etc/passwd')).toBe(false)
  })
})
