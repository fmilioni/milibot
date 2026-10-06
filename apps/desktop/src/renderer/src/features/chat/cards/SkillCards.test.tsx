import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BotSkillsDetails, SkillImportDetails } from './SkillCards'

const botSkills = (changes: Array<{ skill: string; on: boolean; families: string[]; tools: number }>) =>
  JSON.stringify({ changes: changes.map((c) => ({ ...c, allow: false })) })

describe('BotSkillsDetails', () => {
  it('says what a switch on unlocks', () => {
    render(
      <BotSkillsDetails
        details={botSkills([{ skill: 'routines', on: true, families: ['routines'], tools: 4 }])}
        botName="Ana"
      />,
    )
    expect(screen.getByText('Unlocks routines (4 tools)')).toBeTruthy()
  })

  it('says what a switch off removes', () => {
    render(
      <BotSkillsDetails
        details={botSkills([
          { skill: 'routines', on: false, families: ['routines'], tools: 4 },
          { skill: 'team-management', on: false, families: ['team'], tools: 1 },
          { skill: 'notes', on: false, families: [], tools: 0 },
        ])}
        botName="Ana"
      />,
    )
    expect(screen.getByText('Removes routines (4 tools)')).toBeTruthy()
    expect(screen.getByText('Removes team (1 tool)')).toBeTruthy()
    expect(screen.getByText('Removes no tools')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Unlocks')
  })
})

describe('SkillImportDetails', () => {
  it('warns about the tools a SKILL.md asks for under that skill', () => {
    const skill = (name: string, declaredTools: string[]) => ({
      name,
      importAs: name,
      description: '',
      files: 1,
      bytes: 100,
      conflict: 'none',
      hasScripts: false,
      declaredTools,
    })
    render(
      <SkillImportDetails
        details={JSON.stringify({
          source: { kind: 'zip', path: '/workspace/pack.zip' },
          skills: [skill('team-management', ['team', 'secrets']), skill('dup', [])],
          bots: 'all',
          families: [],
        })}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0]?.textContent).toContain('Its SKILL.md asks for team, secrets')
    expect(items[1]?.textContent).not.toContain('SKILL.md')
  })
})
