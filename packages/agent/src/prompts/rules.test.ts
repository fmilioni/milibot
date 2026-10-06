import { readFileSync } from 'node:fs'

import { FIRST_BOT_DEFAULTS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { CLI_ENGINE_DRIVERS } from '../cli/registry'
import { makeBot } from '../test-support/env'
import { TOOL_FAMILY_NAMES } from '../tools/policy'
import { sessionRules } from './lanes'
import { conversationNote, projectNote } from './notes'
import { composeSystemPrompt, globalRules, introInstruction, personaSection } from './rules'
import { CATALOG_DESCRIPTION_MAX, formatSkillCatalog } from './skill-catalog'

// Portuguese on purpose: asserts the pt-BR first-bot persona.

const bot = makeBot({ slug: 'iris', displayNum: 3 })
const prompt = (claudeCode: boolean) =>
  composeSystemPrompt({ bot, team: [], cli: claudeCode ? CLI_ENGINE_DRIVERS.claude_code.wording : null })
const skill = (slug: string) =>
  readFileSync(new URL(`../../skills/${slug}/SKILL.md`, import.meta.url), 'utf8')
const families = (...without: string[]) => new Set(TOOL_FAMILY_NAMES.filter((f) => !without.includes(f)))

describe('global rules', () => {
  it('names the Linux user the tools really run as', () => {
    expect(prompt(false)).toContain('your own Linux user `bot-iris`')
    expect(prompt(true)).toContain('run as the shared Linux user `agent`')
    expect(prompt(true)).not.toContain('your own Linux user `bot-iris`')
  })

  it('tells every bot to write raw ids and /workspace paths, which the app turns into links', () => {
    for (const cc of [false, true]) {
      expect(prompt(cc)).toContain('write its raw id (`bcd_…`')
      expect(prompt(cc)).toContain('absolute /workspace path')
    }
  })

  it('tells every bot to read its own daemon log before guessing why something of its misbehaved', () => {
    for (const cc of [false, true]) expect(prompt(cc)).toContain('read `daemon_logs` with `bot: "me"`')
  })

  it('keeps guidance for specific kinds of work in built-in skills, not in the core', () => {
    for (const cc of [false, true]) {
      for (const topic of ['browser_snapshot', 'screenshot_after', 'repo_checkout', 'plan_write', 'routine_'])
        expect(prompt(cc)).not.toContain(topic)
    }
    expect(skill('web-browsing')).toContain('browser_snapshot reads the page as text with refs')
    expect(skill('web-browsing')).toContain('Never page through a site with screenshots')
    expect(skill('using-the-screen')).toContain('a dock at the bottom center')
    expect(skill('code-and-repos')).toContain('docker compose -p {{bot_slug}}')
    expect(skill('team-management')).toContain("Writing a specialist's system prompt")
  })

  it('mentions request_secret only while the secrets skill is on, and always forbids revealing secrets', () => {
    const on = composeSystemPrompt({ bot, team: [], skills: { catalog: '', families: families() } })
    const off = composeSystemPrompt({ bot, team: [], skills: { catalog: '', families: families('secrets') } })
    expect(on).toContain('get it with request_secret')
    expect(off).not.toContain('request_secret')
    for (const text of [on, off]) expect(text).toContain('Never reveal, print or copy secrets')
  })

  it('decides in the core where work runs, so the skill that says how gets loaded', () => {
    const all = composeSystemPrompt({ bot, team: [], skills: { catalog: '', families: families() } })
    expect(all).toContain('## Sizing the work')
    expect(all).toContain('open a work session for it (plans-and-sessions skill), even without a plan')
    expect(all).toContain('before investigating or starting it here')
    expect(all).toContain('goes on a board first (boards skill)')
    const noBoards = composeSystemPrompt({
      bot,
      team: [],
      skills: { catalog: '', families: families('boards') },
    })
    expect(noBoards).toContain('## Sizing the work')
    expect(noBoards).not.toContain('boards skill')
    const noPlans = composeSystemPrompt({
      bot,
      team: [],
      skills: { catalog: '', families: families('plans') },
    })
    expect(noPlans).not.toContain('## Sizing the work')
    expect(composeSystemPrompt({ bot, team: [], helper: true })).not.toContain('## Sizing the work')
    for (const skill of ['plans-and-sessions', 'boards'])
      expect(readFileSync(new URL(`../../skills/${skill}/SKILL.md`, import.meta.url), 'utf8')).not.toMatch(
        /## When to/,
      )
  })

  it('ends with the catalog of the active skills', () => {
    const catalog = formatSkillCatalog([
      { name: 'web-browsing', description: 'Websites.' },
      { name: 'code-and-repos', description: 'Git\n and PRs.' },
    ])
    const text = composeSystemPrompt({ bot, team: [], skills: { catalog, families: families() } })
    expect(text.endsWith(catalog)).toBe(true)
    expect(catalog).toContain('load its skill with skill_load')
    expect(catalog).toContain('- code-and-repos — Git and PRs.\n- web-browsing — Websites.')
    expect(formatSkillCatalog([])).toBe('')
    expect(prompt(false)).not.toContain('# Skills')
  })

  it('keeps delegation opt-in in the default persona and the core, for every bot', () => {
    for (const language of ['pt-BR', 'en'] as const) {
      const persona = personaSection(makeBot({ systemPrompt: FIRST_BOT_DEFAULTS[language].persona }))
      expect(persona.startsWith('# Your role\n')).toBe(true)
      expect(persona).not.toMatch(/prefer delegating/i)
    }
    expect(FIRST_BOT_DEFAULTS.en.persona).toContain('Do the tasks the user gives you yourself')
    expect(FIRST_BOT_DEFAULTS['pt-BR'].persona).toContain('Faça você mesmo')
    const withTeam = composeSystemPrompt({ bot, team: [], skills: { catalog: '', families: families() } })
    const withoutTeam = composeSystemPrompt({
      bot,
      team: [],
      skills: { catalog: '', families: families('team') },
    })
    for (const text of [withTeam, withoutTeam])
      expect(text).toContain('do it yourself, even when it is long or recurring')
    expect(withTeam).toContain('Create a bot only when the user asks for a bot or a team')
    expect(withoutTeam).not.toContain('Create a bot')
    expect(composeSystemPrompt({ bot, team: [], helper: true })).not.toContain('do it yourself')
    expect(skill('team-management')).not.toContain('do it yourself')
  })

  it("points to the user's documents in the core only while the knowledge base is on", () => {
    const on = composeSystemPrompt({ bot, team: [], skills: { catalog: '', families: families() } })
    const off = composeSystemPrompt({
      bot,
      team: [],
      skills: { catalog: '', families: families('knowledge') },
    })
    expect(on).toContain('search the knowledge base before relying on general knowledge')
    expect(off).not.toContain('knowledge base')
  })

  it('lists teammates without ranks and mentions request_secret in sessions only with the secrets skill', () => {
    const text = composeSystemPrompt({
      bot,
      team: [
        { name: 'Iris', label: '', slug: 'iris' },
        { name: 'Ana', label: 'Finance', slug: 'ana' },
      ],
    })
    expect(text).toContain('# Your role')
    expect(text).toContain('\n\n# Team\n- Ana (Finance)')
    const session = { id: 'ses_1', title: 'Shop', cwd: '/workspace/shop' }
    expect(sessionRules(session)).toContain('request_secret')
    expect(sessionRules(session, null, false)).not.toContain('request_secret')
  })

  it('tells a session to finish once what is left depends on another bot', () => {
    const rules = sessionRules({ id: 'ses_1', title: 'Shop', cwd: '/workspace/shop' })
    expect(rules).toContain('When what is left depends on another bot')
    expect(rules).toMatch(
      /would only wait here, call session_finish: the summary says what you found and who has it now/,
    )
  })

  it("writes for the user in the app's language unless they write in another one", () => {
    const withLanguage = composeSystemPrompt({ bot, team: [], language: 'pt-BR' })
    expect(withLanguage).toContain("The user's language is Brazilian Portuguese")
    expect(withLanguage).toContain('unless the user writes to you in another language')
    expect(prompt(false)).toContain('Reply in the language the user writes in')
    expect(prompt(false)).not.toContain('Workspace settings')
  })

  it('leaves out of a helper what it cannot do: ask the user, save memory, change its role', () => {
    const helper = composeSystemPrompt({ bot, team: [], helper: true })
    for (const tool of ['ask_user', 'memory_save', 'memory_forget', 'update_own_prompt', 'request_secret'])
      expect(helper).not.toContain(tool)
    for (const tool of ['ask_user', 'memory_save', 'memory_forget', 'update_own_prompt'])
      expect(prompt(false)).toContain(tool)
    expect(prompt(false)).toContain('Keep memory current')
    expect(helper).not.toContain('Keep memory current')
    expect(helper).toContain('history_search')
  })

  it('gives both providers the date and the check before saying done', () => {
    for (const cc of [false, true]) {
      expect(prompt(cc)).toContain('Run `date`')
      expect(prompt(cc)).toContain('never claim success you have not seen')
      expect(prompt(cc)).not.toContain('on their Mac')
    }
  })

  it('makes the first message the one introduction', () => {
    expect(introInstruction(bot)).toContain('the one message where you introduce yourself')
  })

  it('cuts long skill descriptions in the catalog', () => {
    const catalog = formatSkillCatalog([{ name: 'long', description: 'word '.repeat(200) }])
    const line = catalog.split('\n').find((l) => l.startsWith('- long — ')) ?? ''
    expect(line.length).toBeLessThanOrEqual('- long — '.length + CATALOG_DESCRIPTION_MAX)
    expect(line.endsWith('…')).toBe(true)
  })

  it('puts the group-chat rules in the group turn note, not in every prompt', () => {
    const ana = makeBot({ id: 'bot_ana', name: 'Ana', slug: 'ana' })
    const group = { type: 'group', title: 'Launch', memberBotIds: [bot.id, ana.id] }
    const note = conversationNote(group as never, bot, new Map([[ana.id, ana]]))
    expect(note).toContain('answer only your part')
    expect(note).toContain('@Name')
    expect(prompt(false)).not.toContain('group chats')
  })

  it('tells a Claude Code turn which project applies', () => {
    const project = { name: 'Acme', block: '# Current project\nAcme' }
    expect(projectNote(project, true)).toBe('[Milibot] # Current project\nAcme')
    expect(projectNote(project, false)).toBe('[Milibot] Current project of this conversation: Acme.')
    expect(projectNote(null, false)).toContain('no current project')
  })
})

describe('persona section', () => {
  it('uses the whole editable persona as the role, for every bot', () => {
    const first = makeBot({ systemPrompt: 'You coordinate the team.\nReport every Friday.' })
    const prompt = composeSystemPrompt({ bot: first, team: [] })
    expect(prompt).toContain('# Your role\nYou coordinate the team.\nReport every Friday.')
  })
})

describe('global rules', () => {
  it('assume no country: conventions come from the workspace memory, which bots maintain', () => {
    const rules = globalRules({ bot: makeBot(), team: [] })
    expect(rules).not.toMatch(/Brazil|pt-BR|R\$/)
    expect(rules).toContain('workspace memory')
    expect(rules).toContain('update_own_prompt')
    expect(rules).toContain('replaces')
  })
})
