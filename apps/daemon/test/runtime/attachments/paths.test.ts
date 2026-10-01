import { describe, expect, it } from 'vitest'

import {
  conversationSlug,
  folderSlug,
  mentionedImagePaths,
  numberedName,
  uniqueName,
  uploadDir,
} from '../../../src/runtime/attachments/paths'
import { localDay } from '../../../src/util/time'

describe('attachment paths', () => {
  it('builds /workspace/uploads/<conversation>/<local day>', () => {
    const at = new Date(2026, 8, 6, 23, 30).getTime()
    expect(localDay(at)).toBe('2026-09-06')
    expect(uploadDir('nina', at)).toBe('/workspace/uploads/nina/2026-09-06')
  })

  it('names the conversation folder after the bot (DM) or the group', () => {
    const bots = [{ id: 'bot_1', slug: 'nina' }]
    expect(
      conversationSlug({ id: 'cnv_1', type: 'direct', title: null, memberBotIds: ['bot_1'] }, bots),
    ).toBe('nina')
    expect(
      conversationSlug(
        { id: 'cnv_2', type: 'group', title: 'Q4 Launch / Café Sales', memberBotIds: [] },
        bots,
      ),
    ).toBe('q4-launch-cafe-sales')
    expect(conversationSlug({ id: 'cnv_01ABCDEF', type: 'group', title: '🎉', memberBotIds: [] }, bots)).toBe(
      'group-abcdef',
    )
    expect(folderSlug('  Crème & Brûlée  ')).toBe('creme-brulee')
  })

  it('numbers repeated names before the extension', () => {
    expect(numberedName('note.txt', 1)).toBe('note.txt')
    expect(numberedName('note.txt', 3)).toBe('note (3).txt')
    expect(numberedName('Makefile', 2)).toBe('Makefile (2)')
    const taken = new Set(['note.txt', 'note (2).txt'])
    expect(uniqueName('note.txt', (c) => taken.has(c))).toBe('note (3).txt')
    expect(uniqueName('other.txt', (c) => taken.has(c))).toBe('other.txt')
  })

  it('finds the /workspace images a text mentions', () => {
    const text = [
      'The preview is at `/workspace/milibot-preview/shadow avatars.png`.',
      'See also /workspace/app/shot.JPG, ![x](/workspace/app/b.webp) and **/workspace/app/c.gif**.',
      'Repeated: /workspace/app/shot.JPG; text: /workspace/app/notes.md; outside: /home/bot/workspace/x.png',
      'Escaping: /workspace/../etc/passwd.png and /workspace/a/../d.jpeg',
    ].join('\n')
    expect(mentionedImagePaths(text, 6)).toEqual([
      '/workspace/milibot-preview/shadow avatars.png',
      '/workspace/app/shot.JPG',
      '/workspace/app/b.webp',
      '/workspace/app/c.gif',
      '/workspace/d.jpeg',
    ])
    expect(mentionedImagePaths(text, 2)).toHaveLength(2)
    expect(mentionedImagePaths('nothing here /workspace/app/', 6)).toEqual([])
  })
})
