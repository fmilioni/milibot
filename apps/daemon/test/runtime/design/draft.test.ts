import { makeBot } from '@milibot/agent/testing'
import type { WorkspaceEvent } from '@milibot/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DesignDrafts,
  extractFrameDraft,
  type FrameDraftPayload,
  trimPartialHtml,
} from '../../../src/runtime/design/draft'

describe('frame drafts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads a design_write_frame input cut anywhere, fields in any order', () => {
    expect(
      extractFrameDraft(
        '{"html": "<p>caf\\u00e9 \\"x\\"\\n</p><di", "width": 390, "name":"Home", "design": "App", "tokens": [{"a": "}"}], "x": 12',
      ),
    ).toEqual({
      design: 'App',
      frame: null,
      name: 'Home',
      width: 390,
      height: undefined,
      theme: null,
      css: null,
      x: null,
      y: null,
      html: '<p>café "x"\n</p><di',
      htmlComplete: true,
    })
    const ordered = extractFrameDraft(
      '{"design":"App","name":"Home","width":390,"height":"auto","html":"<b>ok</b>"}',
    )
    expect(ordered).toMatchObject({ width: 390, height: null, html: '<b>ok</b>', htmlComplete: true })
    expect(extractFrameDraft('{"design":"App","width":390,"html":"a\\u00').html).toBe('a')
    expect(extractFrameDraft('{"design":"App","width":390,"html":"a\\').html).toBe('a')
    expect(extractFrameDraft('{"design":"App","html":"\\ud83d\\ude00 ok \\ud83d').html).toBe('\u{1F600} ok ')
    expect(extractFrameDraft('{"design":"App","html":"<p>').width).toBeNull()
    expect(extractFrameDraft('{"desi')).toMatchObject({ design: null, html: null })
    expect(extractFrameDraft('')).toMatchObject({ design: null, html: null })
  })

  it('drops a tag or entity cut at the end of partial HTML', () => {
    expect(trimPartialHtml('<div class="p-4"><p>Hi &amp; bye</p><span cla')).toBe(
      '<div class="p-4"><p>Hi &amp; bye</p>',
    )
    expect(trimPartialHtml('<p>A &am')).toBe('<p>A ')
    expect(trimPartialHtml('<p>1 < 2 café > 0')).toBe('<p>1 < 2 café > 0')
  })

  it('compiles at most every 500 ms, the latest input, and goes away when the call or turn ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const events: WorkspaceEvent[] = []
    const seen: string[] = []
    const drafts = new DesignDrafts({
      prepare: async (_ctx, input) => {
        seen.push(input.html ?? '')
        return input.html === null
          ? null
          : {
              designId: 'dsg_1',
              frameId: null,
              name: input.name ?? '',
              x: 0,
              y: 0,
              width: input.width ?? 0,
              height: null,
              theme: 'Default',
              html: input.html,
            }
      },
      emit: (event) => events.push(event),
    })
    const bot = makeBot({ slug: 'lia' })
    const ctx = { bot, conversationId: 'cnv_1', turnId: 'trn_1', laneKey: bot.id }
    const head = '{"design":"App","name":"Home","width":390,"html":"'
    drafts.update(ctx, `${head}<h1>`)
    await vi.advanceTimersByTimeAsync(0)
    for (const part of ['<h1>H', '<h1>Hi', '<h1>Hi</h1>']) {
      drafts.update(ctx, `${head}${part}`)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(seen).toEqual(['<h1>'])
    await vi.advanceTimersByTimeAsync(300)
    expect(seen).toEqual(['<h1>', '<h1>Hi</h1>'])
    const shown = events.map((e) => e.payload as FrameDraftPayload)
    expect(shown.map((p) => [p.draftId, p.html])).toEqual([
      ['trn_1:1', '<h1>'],
      ['trn_1:1', '<h1>Hi</h1>'],
    ])

    // A second call in the same turn (its input doesn't extend the first one) is another draft.
    drafts.update({ ...ctx, toolCallId: 'toolu_2' }, `${head}<p>`)
    await vi.advanceTimersByTimeAsync(0)
    expect(events.at(-1)?.payload).toMatchObject({ draftId: 'trn_1:toolu_2', name: 'Home' })

    drafts.callFinished(
      { botId: bot.id, turnId: 'trn_1' },
      { designId: 'dsg_1', frameId: null, name: 'Home' },
    )
    expect(events.at(-1)).toEqual({
      type: 'design.frame.draft.cleared',
      payload: { designId: 'dsg_1', draftId: 'trn_1:1' },
    })
    drafts.update(ctx, `${head}<h1>Hi</h1>","x":1}`)
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toHaveLength(3)

    drafts.turnEnded('trn_1')
    expect(events.at(-1)).toEqual({
      type: 'design.frame.draft.cleared',
      payload: { designId: 'dsg_1', draftId: 'trn_1:toolu_2' },
    })
  })
})
