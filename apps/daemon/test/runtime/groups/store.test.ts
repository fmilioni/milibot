import { describe, expect, it } from 'vitest'

import { ConfirmationStore } from '../../../src/runtime/groups/store'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

describe('ConfirmationStore', () => {
  it('lists the prompt proposals of a bot for another that were not approved, since a time', () => {
    let clock = 1_000
    const store = new WorkspaceStore(openWorkspaceDb(':memory:'), () => clock)
    const ana = store.bots.create({ name: 'Ana' })
    const bia = store.bots.create({ name: 'Bia' })
    const dm = store.conversations.create({ type: 'direct', botIds: [ana.id] })
    const confirmations = new ConfirmationStore(store.db, () => clock)
    const propose = (id: string, target: string) =>
      confirmations.insert({
        id,
        botId: ana.id,
        conversationId: dm.id,
        action: 'update_prompt',
        params: JSON.stringify({ botId: target, data: { turnId: `turn_${id}` } }),
      })
    propose('c1', bia.id)
    clock = 2_000
    propose('c2', bia.id)
    propose('c3', ana.id)
    confirmations.setStatus('c2', 'approved')
    expect(confirmations.find('c1')).toMatchObject({ status: 'pending', message_id: null })
    confirmations.setMessage('c1', 'msg_1')
    expect(confirmations.find('c1')?.message_id).toBe('msg_1')
    expect(
      confirmations.promptProposalParams(ana.id, bia.id, 0).map((p) => JSON.parse(p).data.turnId),
    ).toEqual(['turn_c1'])
    expect(confirmations.promptProposalParams(ana.id, bia.id, 1_500)).toEqual([])
    expect(confirmations.find('missing')).toBeNull()
  })
})
