import { describe, expect, it } from 'vitest'

import { migrate } from '../../../src/db/migrate'
import { workspaceMigrations } from '../../../src/db/migrations/workspace'
import { openDatabase } from '../../../src/db/sqlite'
import { SkillStore } from '../../../src/runtime/skills/store'

function store() {
  const db = openDatabase(':memory:')
  migrate(db, workspaceMigrations)
  db.prepare(
    `INSERT INTO bots (id, name, slug, avatar_shape, avatar_color, avatar_eyes, linux_uid, display_num, created_at, updated_at)
     VALUES ('b1', 'Ana', 'ana', 'square', 'blue', 'capsule', 2001, 1, 1, 1)`,
  ).run()
  let now = 10
  return { skills: new SkillStore(db, () => now++), db }
}

describe('SkillStore', () => {
  it('keeps the rows, their origin and who owns them', () => {
    const { skills } = store()
    skills.insert({ id: 's1', slug: 'pdf', source: 'user', allowed: 'all' })
    expect(skills.rows().get('s1')).toMatchObject({
      slug: 'pdf',
      source: 'user',
      allowed_bots: '"all"',
      enabled: 1,
    })
    skills.markImported('s1', '{"kind":"path"}', '["b1"]')
    expect(skills.rows().get('s1')).toMatchObject({ source: 'import', source_json: '{"kind":"path"}' })
    skills.markBotOwned('s1', 'b1', '["b1"]')
    expect(skills.rows().get('s1')).toMatchObject({ source: 'bot', author_bot_id: 'b1' })
    skills.setSwitch('s1', 0, '"all"')
    expect(skills.rows().get('s1')).toMatchObject({ enabled: 0, allowed_bots: '"all"' })
    skills.delete('s1')
    expect(skills.rows().size).toBe(0)
  })

  it("creates a built-in's row once and keeps each bot's switch", () => {
    const { skills } = store()
    const row = skills.ensure({ id: 'builtin:web', slug: 'builtin:web', source: 'builtin' })
    expect(skills.ensure({ id: 'builtin:web', slug: 'builtin:web', source: 'builtin' })).toEqual(row)
    skills.setPref({ botId: 'b1', skillId: 'builtin:web', enabled: false })
    expect(skills.prefs('b1')).toEqual(new Map([['builtin:web', false]]))
    expect(skills.allPrefs()).toEqual([{ skillId: 'builtin:web', botId: 'b1', enabled: false }])
  })
})
