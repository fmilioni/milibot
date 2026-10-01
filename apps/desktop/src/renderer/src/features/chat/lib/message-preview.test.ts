import { describe, expect, it } from 'vitest'

import { markdownToPlainText } from './message-preview'

describe('markdownToPlainText', () => {
  it('flattens bot markdown for the sidebar preview', () => {
    expect(markdownToPlainText('Created **Test2 (QA2)**. It `runs` [here](https://x.y).')).toBe(
      'Created Test2 (QA2). It runs here.',
    )
    expect(markdownToPlainText('1. **Search** the history\n- item\n## Title')).toBe(
      'Search the history item Title',
    )
    expect(markdownToPlainText('Run:\n\n```bash\nsudo apt update\n```\nDone')).toBe(
      'Run: sudo apt update Done',
    )
  })
})
