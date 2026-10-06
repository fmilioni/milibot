import { readFileSync } from 'node:fs'

import { AVATAR_COLORS, AVATAR_EYES, AVATAR_SHAPES } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { cliPrompt } from '../cli/prompt'
import { CLI_ENGINE_DRIVERS } from '../cli/registry'
import { makeBot } from '../test-support/env'
import { TOOL_DEFINITIONS } from './catalog'
import { describeToolCall } from './describe'
import { browserTools } from './families/browser'
import {
  READ_ONLY_HELPER_TOOLS,
  TOOL_FAMILY_NAMES,
  toolAllowedInLane,
  toolEnabled,
  toolFamily,
  toolsForLane,
} from './policy'

const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name)

const claudeCodeNative = CLI_ENGINE_DRIVERS.claude_code.nativeInMcp

describe('toolsForLane main', () => {
  it('gates team management by its skill, never by the kind of bot', () => {
    const all = new Set(TOOL_FAMILY_NAMES)
    const withoutTeam = new Set([...all].filter((f) => f !== 'team'))
    expect(names(toolsForLane('main', { enabledFamilies: all }))).toEqual(
      expect.arrayContaining(['create_bot', 'update_bot', 'delete_bot', 'create_group']),
    )
    const member = names(toolsForLane('main', { enabledFamilies: withoutTeam }))
    for (const name of ['create_bot', 'update_bot', 'delete_bot', 'create_group'])
      expect(member).not.toContain(name)
    expect(member).toEqual(
      expect.arrayContaining(['message_bot', 'ask_bot', 'add_member', 'remove_member', 'update_own_prompt']),
    )
    expect(toolFamily('add_member')).toBeNull()
  })

  it('leaves Claude Code native tools out of the MCP list', () => {
    expect(names(toolsForLane('main', { native: claudeCodeNative }))).toEqual([
      'computer',
      'browser_snapshot',
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_select_option',
      'browser_scroll',
      'browser_wait_for',
      'browser_tabs',
      'list_bots',
      'create_bot',
      'update_bot',
      'update_own_prompt',
      'set_model',
      'repo_checkout',
      'repo_list',
      'repo_release',
      'memory_save',
      'memory_search',
      'history_search',
      'memory_forget',
      'knowledge_search',
      'knowledge_read',
      'knowledge_list',
      'knowledge_add',
      'knowledge_write',
      'knowledge_edit',
      'knowledge_delete',
      'skill_load',
      'skill_read',
      'skill_save',
      'skill_delete',
      'message_bot',
      'ask_bot',
      'after_current_work',
      'ask_user',
      'request_secret',
      'list_secrets',
      'create_group',
      'add_member',
      'remove_member',
      'delete_bot',
      'report_task',
      'share_file',
      'routine_create',
      'routine_list',
      'routine_update',
      'routine_delete',
      'project_list',
      'project_create',
      'project_update',
      'project_set_current',
      'plan_write',
      'plan_submit',
      'todo_write',
      'plan_step',
      'plan_get',
      'plan_search',
      'session_start',
      'list_models',
      'design_create',
      'design_list',
      'design_read',
      'design_set_tokens',
      'design_write_frame',
      'design_edit_frame',
      'design_draw',
      'design_frame',
      'design_screenshot',
      'design_export',
      'design_archive',
      'design_delete',
      'board_create',
      'board_list',
      'board_get',
      'board_update',
      'board_delete',
      'board_card_write',
      'board_card_get',
      'board_comment',
      'board_link',
      'board_search',
      'generate_image',
      'subagent',
      'workspace_settings_get',
      'workspace_settings_update',
      'mcp_server_list',
      'mcp_server_add',
      'mcp_server_update',
      'mcp_server_remove',
      'mcp_server_test',
      'mcp_server_connect',
      'daemon_logs',
    ])
  })

  it('offers daemon_logs in every lane, to read-only helpers and whatever skills are off', () => {
    const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name)
    for (const lane of ['main', 'internal', 'session', 'subagent'] as const) {
      expect(names(toolsForLane(lane, { enabledFamilies: new Set() }))).toContain('daemon_logs')
      expect(names(toolsForLane(lane, { native: claudeCodeNative }))).toContain('daemon_logs')
    }
    expect(names(toolsForLane('subagent', { readOnly: true, native: claudeCodeNative }))).toContain(
      'daemon_logs',
    )
    expect(toolFamily('daemon_logs')).toBeNull()
  })

  it('gives each lane its own session tools', () => {
    const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name)
    const chat = names(toolsForLane('main'))
    const session = names(toolsForLane('session'))
    const subagent = names(toolsForLane('subagent'))
    expect(chat).toContain('session_start')
    expect(chat).not.toContain('session_finish')
    expect(session).toEqual(expect.arrayContaining(['session_finish', 'todo_write', 'ask_user']))
    expect(session).not.toContain('session_start')
    expect(session).not.toContain('project_set_current')
    expect(subagent).not.toEqual(expect.arrayContaining(['session_finish']))
    expect(subagent).not.toContain('ask_user')
    expect(chat).toContain('after_current_work')
    for (const other of [session, subagent]) expect(other).not.toContain('after_current_work')
    expect(names(toolsForLane('internal'))).toEqual(chat)
  })

  it('offers a family of tools only while its skill is on, keeping what a lane relies on', () => {
    const all = new Set(TOOL_FAMILY_NAMES)
    const without = (...off: string[]) => new Set([...all].filter((f) => !off.includes(f)))
    expect(names(toolsForLane('main', { enabledFamilies: all }))).toEqual(names(toolsForLane('main')))
    const main = names(toolsForLane('main', { enabledFamilies: without('browser', 'team', 'plans') }))
    expect(main).not.toContain('browser_snapshot')
    expect(main).not.toContain('create_bot')
    expect(main).toContain('add_member')
    expect(main).not.toContain('todo_write')
    expect(main).not.toContain('session_start')
    expect(main).toEqual(
      expect.arrayContaining(['computer', 'list_bots', 'message_bot', 'skill_load', 'bash']),
    )
    const session = names(toolsForLane('session', { enabledFamilies: without('plans') }))
    expect(session).toEqual(expect.arrayContaining(['todo_write', 'session_finish', 'subagent']))
    expect(session).not.toContain('plan_write')
    const cc = names(toolsForLane('main', { native: claudeCodeNative, enabledFamilies: without('computer') }))
    expect(cc).not.toContain('computer')
    expect(toolEnabled('computer', 'main', without('computer'))).toBe(false)
    expect(toolEnabled('computer', 'main')).toBe(true)
    expect(toolEnabled('mcp__github__search', 'main', new Set())).toBe(true)
    expect(toolFamily('report_task')).toBe('repos')
    expect(toolFamily('skill_load')).toBeNull()
  })

  it('gives read-only helpers only the tools that look', () => {
    const sorted = (list: readonly string[]) => [...list].sort()
    expect(sorted(names(toolsForLane('subagent', { readOnly: true })))).toEqual(
      sorted(READ_ONLY_HELPER_TOOLS),
    )
    expect(sorted(names(toolsForLane('subagent', { readOnly: true, native: claudeCodeNative })))).toEqual(
      sorted(
        READ_ONLY_HELPER_TOOLS.filter(
          (name) => !['bash', 'file_read', 'grep', 'glob', 'web_search', 'web_fetch'].includes(name),
        ),
      ),
    )
    expect(toolAllowedInLane('knowledge_read', 'subagent', true)).toBe(true)
    for (const name of ['create_bot', 'update_own_prompt', 'knowledge_write', 'computer', 'browser_click'])
      expect(toolAllowedInLane(name, 'subagent', true)).toBe(false)
    expect(toolAllowedInLane('mcp__github__create_issue', 'subagent', true)).toBe(false)
    expect(toolAllowedInLane('mcp__github__create_issue', 'subagent')).toBe(true)
  })

  it('keeps every helper away from the team, its persona, routines and projects', () => {
    const helper = names(toolsForLane('subagent'))
    for (const name of [
      'create_bot',
      'update_bot',
      'delete_bot',
      'create_group',
      'add_member',
      'remove_member',
      'update_own_prompt',
      'set_model',
      'routine_create',
      'routine_update',
      'routine_delete',
      'project_create',
      'project_update',
      'workspace_settings_update',
    ])
      expect(helper).not.toContain(name)
    expect(helper).toEqual(
      expect.arrayContaining([
        'file_write',
        'bash',
        'routine_list',
        'project_list',
        'knowledge_write',
        'workspace_settings_get',
      ]),
    )
  })

  it('gives Claude Code read-only helpers the same MCP tools', () => {
    const bot = makeBot()
    const mcp = (readOnly: boolean) =>
      names(cliPrompt('claude_code', bot, [], null, 'subagent', null, { readOnly }).mcpTools)
    expect(mcp(true)).toEqual(names(toolsForLane('subagent', { readOnly: true, native: claudeCodeNative })))
    expect(mcp(false)).toContain('design_write_frame')
    expect(mcp(true)).not.toContain('design_write_frame')
  })

  it('always offers plan_step: other bots mark the steps of a plan they help with', () => {
    expect(toolFamily('plan_step')).toBeNull()
    const main = names(toolsForLane('internal', { enabledFamilies: new Set() }))
    expect(main).toContain('plan_step')
    expect(main).not.toContain('plan_write')
  })

  it('documents that GUI actions return a screenshot only on request', () => {
    const computer = TOOL_DEFINITIONS.computer
    expect(computer.inputSchema.properties.screenshot_after.type).toBe('boolean')
    expect(computer.description).toContain('screenshot_after')
  })
})

describe('browser tools', () => {
  const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name)
  const browser = Object.keys(browserTools.definitions)

  it('are offered to every bot, API providers and Claude Code alike', () => {
    expect(names(toolsForLane('main'))).toEqual(expect.arrayContaining(browser))
    expect(names(toolsForLane('main', { native: claudeCodeNative }))).toEqual(expect.arrayContaining(browser))
  })

  it('keep their definitions short', () => {
    const size = JSON.stringify(Object.values(browserTools.definitions)).length
    expect(size / 3.5).toBeLessThan(1600)
  })

  it('describe steps for the activity card', () => {
    expect(describeToolCall('browser_navigate', { url: 'https://mail.google.com/' })).toEqual({
      kind: 'browser_navigate',
      detail: 'mail.google.com',
    })
    expect(describeToolCall('browser_navigate', { url: 'back' }).kind).toBe('browser_back')
    expect(describeToolCall('browser_tabs', { action: 'new', url: 'example.com' })).toEqual({
      kind: 'browser_tab_new',
      detail: 'example.com',
    })
    expect(describeToolCall('browser_snapshot', {})).toEqual({ kind: 'browser_snapshot', detail: '' })
    expect(describeToolCall('browser_type', { ref: 'e3', text: 'debian' }).detail).toBe('debian')
  })
})

describe('user requests', () => {
  it('describe the steps without secret values', () => {
    expect(
      describeToolCall('ask_user', {
        questions: [{ header: 'Account', question: 'Which account should I use?', options: [] }],
      }),
    ).toEqual({ kind: 'ask_user', detail: 'Which account should I use?' })
    expect(describeToolCall('request_secret', { name: 'BANK_PASSWORD', label: 'Bank password' })).toEqual({
      kind: 'request_secret',
      detail: 'Bank password',
    })
    expect(describeToolCall('list_secrets', {})).toEqual({ kind: 'list_secrets', detail: '' })
    expect(describeToolCall('browser_type', { ref: 'e3', text: '{{secret:BANK_PASSWORD}}' }).detail).toBe(
      '•••• (BANK_PASSWORD)',
    )
    expect(describeToolCall('computer', { action: 'type', text: 'pin {{secret:PIN}}' }).detail).toBe(
      'pin •••• (PIN)',
    )
  })
})

describe('web tools', () => {
  it('reach every native lane but never Claude Code, which has its own', () => {
    for (const lane of ['main', 'session'] as const)
      expect(names(toolsForLane(lane))).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
    expect(names(toolsForLane('subagent', { readOnly: true }))).toEqual(
      expect.arrayContaining(['web_search', 'web_fetch']),
    )
    for (const lane of ['main', 'session', 'subagent'] as const) {
      const claudeCode = names(toolsForLane(lane, { native: claudeCodeNative }))
      expect(claudeCode).not.toContain('web_search')
      expect(claudeCode).not.toContain('web_fetch')
    }
  })

  it('offer web_search only while its setting family is on; web_fetch always', () => {
    expect(toolFamily('web_search')).toBe('web_search')
    expect(toolFamily('web_fetch')).toBeNull()
    const withoutSearch = new Set(TOOL_FAMILY_NAMES.filter((f) => f !== 'web_search'))
    const main = names(toolsForLane('main', { enabledFamilies: withoutSearch }))
    expect(main).not.toContain('web_search')
    expect(main).toContain('web_fetch')
  })

  it('describe steps by the query and a short URL', () => {
    expect(describeToolCall('web_search', { query: 'node 24 release date' })).toEqual({
      kind: 'web_search',
      detail: 'node 24 release date',
    })
    expect(describeToolCall('web_fetch', { url: 'https://nodejs.org/api/net.html', prompt: 'x' })).toEqual({
      kind: 'web_fetch',
      detail: 'nodejs.org/api/net.html',
    })
    expect(
      describeToolCall('web_fetch', { url: 'https://nodejs.org/api/net.html' }, { full: true }).detail,
    ).toBe('https://nodejs.org/api/net.html')
  })
})

describe('board tools', () => {
  it('come with the boards skill; read-only helpers only read them', () => {
    expect(toolFamily('board_card_write')).toBe('boards')
    const helper = names(toolsForLane('subagent', { readOnly: true }))
    for (const read of ['board_list', 'board_get', 'board_card_get', 'board_search'])
      expect(helper).toContain(read)
    for (const write of ['board_create', 'board_card_write', 'board_comment', 'board_delete'])
      expect(helper).not.toContain(write)
    expect(names(toolsForLane('subagent'))).not.toContain('board_create')
    expect(names(toolsForLane('session'))).toContain('board_card_write')
  })

  it('describe steps by titles, never by ids', () => {
    expect(describeToolCall('board_card_get', { card: 'bcd_01x' })).toEqual({
      kind: 'board_card_get',
      detail: '',
    })
    expect(describeToolCall('board_card_write', { card: 'bcd_01x', title: 'Login' })).toEqual({
      kind: 'board_card_write',
      detail: 'Login',
    })
  })
})

describe('design tools', () => {
  it('come with the design skill and stay out of read-only helpers when they write', () => {
    expect(toolFamily('design_write_frame')).toBe('design')
    const helper = names(toolsForLane('subagent', { readOnly: true }))
    expect(helper).toEqual(expect.arrayContaining(['design_read', 'design_screenshot', 'design_list']))
    for (const name of [
      'design_create',
      'design_write_frame',
      'design_edit_frame',
      'design_draw',
      'design_frame',
      'design_export',
      'design_archive',
      'design_delete',
    ])
      expect(helper).not.toContain(name)
  })

  it('describe steps by names, never by ids', () => {
    expect(describeToolCall('design_write_frame', { design: 'dsg_01x', name: 'Home' })).toEqual({
      kind: 'design_write_frame',
      detail: 'Home',
    })
    expect(describeToolCall('design_frame', { frame: 'dfr_01abc', action: 'move' }).detail).toBe('')
    expect(describeToolCall('design_export', { design: 'App', format: 'pdf' }).detail).toBe('App')
  })
})

describe('terse tool descriptions', () => {
  const skill = (slug: string) =>
    readFileSync(new URL(`../../skills/${slug}/SKILL.md`, import.meta.url), 'utf8')

  it('point the skill-gated families at the skill that documents their parameters', () => {
    const pointers: Array<[string, string]> = [
      ['plan_write', 'plans-and-sessions'],
      ['session_start', 'plans-and-sessions'],
      ['create_bot', 'team-management'],
      ['routine_create', 'routines'],
      ['project_create', 'projects'],
      ['skill_save', 'skill-creator'],
    ]
    for (const [tool, slug] of pointers) {
      expect(TOOL_DEFINITIONS[tool as keyof typeof TOOL_DEFINITIONS].description).toContain(slug)
      expect(skill(slug)).toContain(tool)
    }
    for (const slug of ['plans-and-sessions', 'team-management', 'routines', 'projects', 'knowledge-base'])
      expect(skill(slug)).toContain('## Tool reference')
  })

  it('lists every avatar value in the team-management skill', () => {
    const reference = skill('team-management')
    for (const value of [...AVATAR_SHAPES, ...AVATAR_COLORS, ...AVATAR_EYES])
      expect(reference).toContain(value)
  })
})

describe('apply_patch steps', () => {
  it('name the files of unified and Codex patches', () => {
    const unified = '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-x\n+y\n--- /dev/null\n+++ b/src/new.ts\n@@\n+z\n'
    expect(describeToolCall('apply_patch', { patch: unified }).detail).toBe('src/a.ts, src/new.ts')
    const codex =
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Delete File: old.ts\n*** End Patch'
    expect(describeToolCall('apply_patch', { patch: codex }).detail).toBe('src/a.ts, old.ts')
  })
})
