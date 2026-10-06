import { type Board, type BoardCard, newId, type Project, type RefInfo, type Routine } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('refs')
afterEach(stopRuntimes)

describe('resolving ids written in text', () => {
  it('names every kind in one call, with what the app needs to open it', async () => {
    const h = await bootRuntime({ dir: dir(), vm: false })
    const board = await h.call<Board>('createBoard', {}, { title: 'Release 0.4' })
    const card = await h.call<BoardCard>('createBoardCard', { boardId: board.id }, { title: 'Clickable ids' })
    const project = await h.call<Project>('createProject', {}, { name: 'Milibot' })
    const routine = await h.call<Routine>(
      'createRoutine',
      { botId: h.botId },
      { name: 'Daily digest', prompt: 'Summarize', cron: '0 9 * * *' },
    )
    const designId = newId('design')
    const frameId = newId('designFrame')
    const now = Date.now()
    h.db
      .prepare('INSERT INTO designs (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(designId, 'Card modal', now, now)
    h.db
      .prepare(
        `INSERT INTO design_frames (id, design_id, name, x, y, width, html, position, updated_at)
         VALUES (?, ?, 'Desktop', 0, 0, 1280, '<div></div>', 0, ?)`,
      )
      .run(frameId, designId, now)
    const planId = newId('plan')
    const deletedPlanId = newId('plan')
    const insertPlan = h.db.prepare(
      `INSERT INTO plans (id, bot_id, conversation_id, title, summary, body, status, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, '', '', 'draft', ?, ?, ?)`,
    )
    insertPlan.run(planId, h.botId, h.dm, 'Links plan', now, now, null)
    insertPlan.run(deletedPlanId, h.botId, h.dm, 'Gone', now, now, now)
    const skill = { id: newId('skill'), slug: 'weekly-report' }
    h.db
      .prepare("INSERT INTO skills (id, slug, source, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)")
      .run(skill.id, skill.slug, now, now)
    const bot = h.store.bots.get(h.botId)

    const ids = [
      card.id,
      board.id,
      designId,
      frameId,
      planId,
      deletedPlanId,
      project.id,
      routine.id,
      h.botId,
      h.dm,
      newId('boardCard'),
      'plan_submit',
      newId('message'),
      skill.id,
    ]
    const { refs } = await h.call<{ refs: RefInfo[] }>('resolveRefs', {}, { ids })
    const byId = new Map(refs.map((r) => [r.id, r]))
    expect(byId.get(card.id)).toEqual({ id: card.id, kind: 'card', name: 'Clickable ids', boardId: board.id })
    expect(byId.get(board.id)).toEqual({ id: board.id, kind: 'board', name: 'Release 0.4' })
    expect(byId.get(designId)).toEqual({ id: designId, kind: 'design', name: 'Card modal' })
    expect(byId.get(frameId)).toEqual({ id: frameId, kind: 'frame', name: 'Desktop', designId })
    expect(byId.get(planId)).toEqual({ id: planId, kind: 'plan', name: 'Links plan' })
    expect(byId.get(project.id)).toEqual({ id: project.id, kind: 'project', name: 'Milibot' })
    expect(byId.get(routine.id)).toEqual({
      id: routine.id,
      kind: 'routine',
      name: 'Daily digest',
      botId: h.botId,
    })
    expect(byId.get(h.botId)).toEqual({ id: h.botId, kind: 'bot', name: bot.name })
    expect(byId.get(h.dm)).toEqual({
      id: h.dm,
      kind: 'conversation',
      name: bot.name,
      conversationType: 'direct',
      botId: h.botId,
    })
    expect(byId.get(skill.id)).toEqual({ id: skill.id, kind: 'skill', name: skill.slug })
    // Deleted, unknown and non-linked ids are left out.
    expect(refs).toHaveLength(10)
  })

  it('refuses more ids than one call takes', async () => {
    const h = await bootRuntime({ dir: dir(), vm: false })
    const ids = Array.from({ length: 201 }, () => newId('boardCard'))
    await expect(h.call('resolveRefs', {}, { ids })).rejects.toThrow()
  })
})
