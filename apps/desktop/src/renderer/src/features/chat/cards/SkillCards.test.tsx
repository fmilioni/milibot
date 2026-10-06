import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BotSkillsDetails } from './SkillCards'

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
