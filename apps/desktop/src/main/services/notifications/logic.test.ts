import type { Message, MessagePayload, WorkspaceEvent } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  classifyEvent,
  firstLine,
  groupNotifications,
  isNotificationCandidate,
  type NotifyCandidate,
  type NotifyPreferences,
  shouldNotify,
  type WorkspaceFocus,
} from './logic'

// Portuguese on purpose: asserts the pt-BR notification texts.

const names: Record<string, string> = { bot_iris: 'Iris', bot_chief: 'Chief' }
const ctx = {
  workspaceId: 'ws_1',
  language: 'pt-BR' as const,
  botName: (id: string) => names[id] ?? null,
  workspaceName: 'Personal',
}

function finished(
  patch: Partial<Extract<WorkspaceEvent, { type: 'turn.finished' }>['payload']> = {},
): WorkspaceEvent {
  return {
    type: 'turn.finished',
    payload: {
      botId: 'bot_iris',
      conversationId: 'conv_iris',
      turnId: 'turn_1',
      trigger: 'user_message',
      outcome: 'done',
      reply: 'Done!\nDetails below.',
      routine: null,
      ...patch,
    },
  }
}

function card(payload: MessagePayload, authorBotId: string | null = 'bot_iris'): WorkspaceEvent {
  const message: Message = {
    id: 'msg_1',
    conversationId: 'conv_iris',
    authorType: authorBotId ? 'bot' : 'system',
    authorBotId,
    kind: 'card',
    content: '',
    payload,
    createdAt: 1,
  }
  return { type: 'message.created', payload: { message } }
}

const prefs: NotifyPreferences = { enabled: true, mutedBots: new Set(), routines: 'always' }
const away: WorkspaceFocus = { focused: false, conversationId: null }

describe('isNotificationCandidate', () => {
  it('lets through every event classifyEvent can notify about', () => {
    for (const trigger of ['user_message', 'session_finished', 'routine'] as const) {
      expect(isNotificationCandidate(finished({ trigger })), trigger).toBe(true)
      expect(classifyEvent(finished({ trigger }), ctx), trigger).not.toBeNull()
    }
    expect(isNotificationCandidate(card({ type: 'error', code: 'turn_crashed', detail: 'boom' }))).toBe(true)
  })

  it('drops turns nobody waits for and plain messages', () => {
    for (const trigger of ['bot_message', 'bot_reply', 'intro', 'subagent'] as const)
      expect(isNotificationCandidate(finished({ trigger })), trigger).toBe(false)
    expect(isNotificationCandidate({ type: 'runtime.status', payload: { status: 'running' } })).toBe(false)
  })
})

describe('classifyEvent', () => {
  it('turns a finished user turn into a reply with the first line', () => {
    expect(classifyEvent(finished(), ctx)).toEqual({
      kind: 'reply',
      workspaceId: 'ws_1',
      conversationId: 'conv_iris',
      botId: 'bot_iris',
      reason: 'reply',
      title: 'Iris',
      body: 'Done!',
    })
  })

  it('strips markdown and falls back when the bot wrote nothing', () => {
    expect(classifyEvent(finished({ reply: '## **Summary**\n- item' }), ctx)?.body).toBe('Summary')
    expect(classifyEvent(finished({ reply: '' }), ctx)?.body).toBe('Terminou a tarefa.')
  })

  it('ignores turns the user did not start, stopped turns and failures without a card', () => {
    for (const trigger of ['intro', 'group_message', 'bot_message', 'bot_reply'] as const)
      expect(classifyEvent(finished({ trigger }), ctx)).toBeNull()
    expect(classifyEvent(finished({ outcome: 'cancelled' }), ctx)).toBeNull()
    expect(classifyEvent(finished({ outcome: 'error' }), ctx)).toBeNull()
  })

  it('reports routine runs that finished or failed', () => {
    const routine = { id: 'rtn_1', name: 'Report' }
    expect(classifyEvent(finished({ trigger: 'routine', routine, reply: 'All good.' }), ctx)).toMatchObject({
      kind: 'routine',
      reason: 'done',
      body: 'Rotina “Report” concluída: All good.',
    })
    expect(classifyEvent(finished({ trigger: 'routine', routine, outcome: 'error' }), ctx)).toMatchObject({
      kind: 'routine',
      reason: 'failed',
      body: 'Rotina “Report” falhou',
    })
    expect(classifyEvent(finished({ trigger: 'routine', routine, outcome: 'cancelled' }), ctx)).toBeNull()
  })

  it('flags what needs the user', () => {
    const confirmation = (action: string, status: 'pending' | 'approved' = 'pending') =>
      card({
        type: 'confirmation',
        confirmationId: 'cf_1',
        action,
        description: 'Ana is no longer used.',
        status,
        params: { botName: 'Ana' },
      })
    expect(classifyEvent(confirmation('delete_bot'), ctx)).toMatchObject({
      kind: 'attention',
      reason: 'confirmation',
      title: 'Iris',
      body: 'Precisa da sua confirmação: Ana is no longer used.',
    })
    expect(classifyEvent(confirmation('update_prompt'), ctx)).toMatchObject({
      reason: 'prompt_approval',
      body: 'Quer mudar o prompt de Ana. Aprove ou recuse.',
    })
    expect(classifyEvent(confirmation('delete_bot', 'approved'), ctx)).toBeNull()
    expect(
      classifyEvent(
        card({ type: 'error', code: 'cli_login_required', params: { engine: 'claude_code' }, detail: '' }),
        ctx,
      ),
    ).toMatchObject({
      reason: 'login_required',
      botId: 'bot_iris',
      body: 'Faça login no Claude Code para continuar.',
    })
    expect(
      classifyEvent(
        card({ type: 'error', code: 'cli_login_required', detail: '', params: { engine: 'codex' } }),
        ctx,
      ),
    ).toMatchObject({ reason: 'login_required', body: 'Faça login no Codex para continuar.' })
    expect(classifyEvent(card({ type: 'error', code: 'turn_crashed', detail: 'boom' }), ctx)).toMatchObject({
      reason: 'turn_crashed',
    })
    expect(classifyEvent(card({ type: 'error', code: 'provider_error', detail: '' }), ctx)).toBeNull()
  })

  it('flags a pending MCP sign-in', () => {
    const signIn = (status: 'pending' | 'connected') =>
      card({
        type: 'mcp_sign_in',
        serverId: 'mcp_1',
        serverName: 'Notion',
        botId: 'bot_iris',
        authorizationUrl: 'https://auth.example.com/authorize',
        status,
      })
    expect(classifyEvent(signIn('pending'), ctx)).toMatchObject({
      kind: 'attention',
      reason: 'mcp_sign_in',
      title: 'Iris',
      body: 'Precisa que você entre no servidor MCP Notion',
    })
    expect(classifyEvent(signIn('connected'), ctx)).toBeNull()
  })

  it('flags pending passwords and questions, never the answered ones', () => {
    const secret = (status: 'pending' | 'answered', asEnv = false) =>
      card({
        type: 'secret_request',
        requestId: 'ureq_1',
        botId: 'bot_iris',
        name: 'WEBMAIL_PASSWORD',
        label: 'Webmail password',
        reason: 'To download the invoices.',
        asEnv,
        status,
      })
    expect(classifyEvent(secret('pending'), ctx)).toMatchObject({
      kind: 'attention',
      reason: 'secret_request',
      title: 'Iris',
      body: 'Precisa de uma senha: Webmail password',
    })
    expect(classifyEvent(secret('pending', true), ctx)).toMatchObject({
      body: 'Precisa de uma variável de ambiente: Webmail password',
    })
    expect(classifyEvent(secret('answered'), ctx)).toBeNull()
    const question = {
      header: 'Format',
      options: [{ label: 'PDF' }, { label: 'Spreadsheet' }],
      multiSelect: false,
    }
    const ask = (count: number, status: 'pending' | 'answered_in_chat' = 'pending') =>
      card({
        type: 'question',
        requestId: 'ureq_2',
        botId: 'bot_iris',
        questions: Array.from({ length: count }, (_, i) => ({
          ...question,
          question: `Question **${i + 1}**?`,
        })),
        status,
      })
    expect(classifyEvent(ask(1), ctx)).toMatchObject({
      kind: 'attention',
      reason: 'question',
      body: 'Tem uma pergunta: Question 1?',
    })
    expect(classifyEvent(ask(3), ctx)).toMatchObject({ body: 'Tem 3 perguntas: Question 1?' })
    expect(classifyEvent(ask(1, 'answered_in_chat'), ctx)).toBeNull()
  })

  it('flags a plan waiting for approval, never a decided or removed one', () => {
    const plan = (status: 'awaiting_approval' | 'approved', removed = false) =>
      card({
        type: 'plan',
        planId: 'plan_1',
        botId: 'bot_iris',
        title: 'Lisbon itinerary',
        summary: 'Five days',
        revision: 1,
        status,
        execution: 'chat',
        steps: { done: 0, total: 3 },
        ...(removed ? { removed } : {}),
      })
    expect(classifyEvent(plan('awaiting_approval'), ctx)).toMatchObject({
      kind: 'attention',
      reason: 'plan_approval',
      title: 'Iris',
      body: 'Enviou um plano para você aprovar: Lisbon itinerary',
    })
    expect(classifyEvent(plan('approved'), ctx)).toBeNull()
    expect(classifyEvent(plan('awaiting_approval', true), ctx)).toBeNull()
  })

  it('reports the spend pause for the whole workspace, not the warning', () => {
    const spend = (paused: boolean) =>
      card({ type: 'spend_warning', spentUsd: 12, warnUsd: 5, limitUsd: 10, paused }, null)
    expect(classifyEvent(spend(true), ctx)).toMatchObject({
      kind: 'attention',
      reason: 'spend_paused',
      botId: null,
      title: 'Personal',
    })
    expect(classifyEvent(spend(false), ctx)).toBeNull()
  })

  it('writes English when the app is in English', () => {
    expect(classifyEvent(finished({ reply: '' }), { ...ctx, language: 'en' })?.body).toBe(
      'Finished the task.',
    )
  })
})

describe('shouldNotify', () => {
  const reply = classifyEvent(finished(), ctx) as NotifyCandidate
  const attention = classifyEvent(
    card({ type: 'error', code: 'turn_crashed', detail: '' }),
    ctx,
  ) as NotifyCandidate
  const routineDone = classifyEvent(
    finished({ trigger: 'routine', routine: { id: 'r', name: 'R' } }),
    ctx,
  ) as NotifyCandidate
  const routineFailed = { ...routineDone, reason: 'failed' }

  it('notifies replies only while the workspace window is not focused', () => {
    expect(shouldNotify(reply, prefs, away)).toBe(true)
    expect(shouldNotify(reply, prefs, { focused: true, conversationId: 'conv_other' })).toBe(false)
  })

  it('never notifies about the conversation on screen, but does for other ones when it needs the user', () => {
    expect(shouldNotify(attention, prefs, { focused: true, conversationId: 'conv_iris' })).toBe(false)
    expect(shouldNotify(attention, prefs, { focused: true, conversationId: 'conv_other' })).toBe(true)
    expect(shouldNotify(attention, prefs, { focused: false, conversationId: 'conv_iris' })).toBe(true)
  })

  it('honors the workspace switch and the bot switch', () => {
    expect(shouldNotify(attention, { ...prefs, enabled: false }, away)).toBe(false)
    expect(shouldNotify(reply, { ...prefs, mutedBots: new Set(['bot_iris']) }, away)).toBe(false)
    const spend = { ...attention, botId: null }
    expect(shouldNotify(spend, { ...prefs, mutedBots: new Set(['bot_iris']) }, away)).toBe(true)
  })

  it('notifies routines always, or only failures with "attention"', () => {
    expect(shouldNotify(routineDone, prefs, away)).toBe(true)
    expect(shouldNotify(routineDone, { ...prefs, routines: 'attention' }, away)).toBe(false)
    expect(shouldNotify(routineFailed, { ...prefs, routines: 'attention' }, away)).toBe(true)
    expect(shouldNotify(routineDone, prefs, { focused: true, conversationId: 'conv_other' })).toBe(true)
  })
})

describe('groupNotifications', () => {
  const candidate = (patch: Partial<NotifyCandidate>): NotifyCandidate => ({
    kind: 'reply',
    workspaceId: 'ws_1',
    conversationId: 'conv_iris',
    botId: 'bot_iris',
    reason: 'reply',
    title: 'Iris',
    body: 'Done!',
    ...patch,
  })

  it('shows a single notification as is', () => {
    expect(groupNotifications([candidate({})], 'pt-BR')).toEqual([
      { title: 'Iris', body: 'Done!', workspaceId: 'ws_1', conversationId: 'conv_iris' },
    ])
    expect(groupNotifications([], 'pt-BR')).toEqual([])
  })

  it('drops the "finished" of a turn whose card already asks for the user', () => {
    const crash = candidate({ kind: 'attention', reason: 'turn_crashed', body: 'The task stopped.' })
    expect(groupNotifications([crash, candidate({})], 'pt-BR')).toEqual([
      { title: 'Iris', body: 'The task stopped.', workspaceId: 'ws_1', conversationId: 'conv_iris' },
    ])
  })

  it('joins what one bot said and summarizes several bots, attention first', () => {
    expect(
      groupNotifications(
        [candidate({ body: 'One' }), candidate({ kind: 'routine', reason: 'done', body: 'Routine ok' })],
        'pt-BR',
      ),
    ).toEqual([{ title: 'Iris', body: 'One\nRoutine ok', workspaceId: 'ws_1', conversationId: 'conv_iris' }])

    const grouped = groupNotifications(
      [
        candidate({ body: 'One' }),
        candidate({ botId: 'bot_chief', title: 'Chief', conversationId: 'conv_chief', body: 'Two' }),
        candidate({
          kind: 'attention',
          reason: 'confirmation',
          botId: 'bot_ana',
          title: 'Ana',
          conversationId: 'conv_ana',
          body: 'Needs your confirmation',
        }),
        candidate({ botId: 'bot_leo', title: 'Leo', conversationId: 'conv_leo', body: 'Four' }),
      ],
      'pt-BR',
    )
    expect(grouped).toEqual([
      {
        title: '4 novidades',
        body: 'Ana: Needs your confirmation\nIris: One\nChief: Two\ne mais 1',
        workspaceId: 'ws_1',
        conversationId: 'conv_ana',
      },
    ])
  })

  it('ignores exact repeats', () => {
    expect(groupNotifications([candidate({}), candidate({})], 'pt-BR')).toHaveLength(1)
    expect(groupNotifications([candidate({}), candidate({})], 'pt-BR')[0]?.body).toBe('Done!')
  })
})

describe('firstLine', () => {
  it('cuts long lines and skips code blocks', () => {
    expect(firstLine('```ts\nconst x = 1\n```\nDone.')).toBe('Done.')
    expect(firstLine('a'.repeat(300))).toHaveLength(180)
  })
})
