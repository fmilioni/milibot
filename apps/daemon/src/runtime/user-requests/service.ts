import type { AgentHost, NewAgentMessage, ToolExecContext } from '@milibot/agent'
import {
  type AnswerQuestionBody,
  type AnswerSecretBody,
  DEFAULT_USER_REQUEST_TIMEOUT_SECONDS,
  type EnvSecretScope,
  type LogFn,
  type Message,
  type MessagePayload,
  newId,
  type QuestionAnswer,
  type QuestionPayload,
  type SecretRequestPayload,
  type SecretScope,
  USER_REQUEST_TIMEOUT_KEY,
  type UserQuestion,
  type userRequestEndpoints,
  type UserRequestExpiredReason,
} from '@milibot/shared'
import type { z } from 'zod'

import { parseJson } from '../../db/sqlite'
import { DaemonError, errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { CredentialService } from '../credentials'
import { stopped } from '../tools-core'
import type { WorkspaceStore } from '../workspace-store'
import {
  type QuestionParams,
  type RequestKind,
  type SecretParams,
  type UserRequestRow,
  UserRequestStore,
} from './store'
import { questionContent, questionOutcomeText, questionResultText, secretOutcomeText } from './texts'

/** Pending requests older than this are expired when the runtime starts. */
const STALE_AFTER_MS = 24 * 60 * 60_000

const NO_SECRET: SecretParams = { name: '', label: '', reason: '', asEnv: false, replace: false }

export type Resolution =
  | { status: 'answered'; answers: QuestionAnswer[] }
  | { status: 'answered_in_chat'; text: string }
  | { status: 'provided'; remember: boolean; scope: SecretScope }
  | { status: 'declined' }

interface Waiter {
  resolve(resolution: Resolution): void
  reject(err: Error): void
}

/** `resolveConfirmation` belongs to the groups' confirmation cards. */
type UserRequestEndpoint = Exclude<keyof typeof userRequestEndpoints, 'resolveConfirmation'>

export interface UserRequestServiceDeps {
  store: WorkspaceStore
  host: Pick<AgentHost, 'enqueueTurn'>
  credentials: Pick<
    CredentialService,
    'findSecret' | 'updateEnvSecret' | 'createEnvSecret' | 'setTemporarySecret' | 'syncSecretFiles'
  >
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  getMessage: (id: string) => Message
  now: () => number
  log?: LogFn
}

/**
 * Questions and secrets a bot asks the user for: the card in the chat, the tool call waiting for the answer
 * (detached from the bot's slot) and, once it stopped waiting, a `user_answer` turn with the late answer.
 */
export class UserRequestService {
  private readonly requests: UserRequestStore
  private readonly waiters = new Map<string, Waiter>()
  /** Secret answers being stored (the value goes to the secret store before the request is marked). */
  private readonly resolving = new Set<string>()

  constructor(private readonly deps: UserRequestServiceDeps) {
    this.requests = new UserRequestStore(deps.store.db, deps.now)
  }

  /** Pending requests left from long ago or from deleted bots expire. */
  start(): void {
    const cutoff = this.deps.now() - STALE_AFTER_MS
    const bots = new Set(this.deps.store.bots.list().map((b) => b.id))
    for (const row of this.requests.pending()) {
      if (!bots.has(row.bot_id)) this.expire(row, 'bot_deleted')
      else if (row.created_at < cutoff) this.expire(row, 'timeout')
    }
  }

  stop(): void {
    for (const waiter of [...this.waiters.values()]) waiter.reject(stopped())
  }

  timeoutSeconds(): number {
    const value = this.deps.store.settings.get<number>(
      USER_REQUEST_TIMEOUT_KEY,
      DEFAULT_USER_REQUEST_TIMEOUT_SECONDS,
    )
    return typeof value === 'number' && value > 0 ? value : DEFAULT_USER_REQUEST_TIMEOUT_SECONDS
  }

  /** Posts a question card and waits for the answer (or the timeout). */
  askQuestions(ctx: ToolExecContext, questions: UserQuestion[]): Promise<Resolution | 'timeout'> {
    const payload = (id: string): QuestionPayload => ({
      type: 'question',
      requestId: id,
      botId: ctx.bot.id,
      questions,
      status: 'pending',
    })
    return this.request(ctx, 'question', { questions } satisfies QuestionParams, (id) => ({
      content: questionContent(questions),
      payload: payload(id),
    }))
  }

  /** Posts a secret request card and waits for the user (or the timeout). */
  askSecret(ctx: ToolExecContext, params: SecretParams): Promise<Resolution | 'timeout'> {
    const { name, label, reason, asEnv } = params
    const payload = (id: string): SecretRequestPayload => ({
      type: 'secret_request',
      requestId: id,
      botId: ctx.bot.id,
      name,
      label,
      reason,
      asEnv,
      status: 'pending',
    })
    return this.request(ctx, 'secret', params, (id) => ({
      content: `${ctx.bot.name} asked for ${label}${reason ? `: ${reason}` : ''}`,
      payload: payload(id),
    }))
  }

  private request(
    ctx: ToolExecContext,
    kind: RequestKind,
    params: SecretParams | QuestionParams,
    card: (id: string) => { content: string; payload: MessagePayload },
  ): Promise<Resolution | 'timeout'> {
    const id = newId('userRequest')
    const conversationId = this.deps.store.conversations.forCard(ctx.bot, ctx.conversationId)
    this.requests.insert({ id, kind, botId: ctx.bot.id, conversationId, turnId: ctx.turnId, params })
    const message = this.deps.appendMessage({
      conversationId,
      authorType: 'bot',
      authorBotId: ctx.bot.id,
      kind: 'card',
      ...card(id),
      turnId: ctx.turnId,
    })
    this.requests.setMessage(id, message.id)
    return this.wait(ctx, id)
  }

  private wait(ctx: ToolExecContext, id: string): Promise<Resolution | 'timeout'> {
    const seconds = this.timeoutSeconds()
    const wait = new Promise<Resolution | 'timeout'>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        this.waiters.delete(id)
      }
      const onAbort = () => {
        cleanup()
        const row = this.requests.find(id)
        if (row?.status === 'pending') this.expire(row, 'stopped')
        reject(stopped())
      }
      const timer = setTimeout(
        () => {
          cleanup()
          resolve('timeout')
        },
        Math.max(10, seconds * 1000),
      )
      this.waiters.set(id, {
        resolve: (resolution) => {
          cleanup()
          resolve(resolution)
        },
        reject: (err) => {
          cleanup()
          reject(err)
        },
      })
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal.aborted) onAbort()
    })
    return ctx.detach ? ctx.detach(wait) : wait
  }

  private card(row: UserRequestRow): Message {
    if (!row.message_id) throw new DaemonError('not_found', 'request card not found')
    return this.deps.getMessage(row.message_id)
  }

  private updateCard(
    row: UserRequestRow,
    patch: Partial<QuestionPayload> | Partial<SecretRequestPayload>,
    content?: string,
  ): Message | null {
    if (!row.message_id) return null
    try {
      const current = this.deps.getMessage(row.message_id)
      if (current.payload?.type !== 'question' && current.payload?.type !== 'secret_request') return current
      return this.deps.updateMessage(row.message_id, {
        ...(content !== undefined ? { content } : {}),
        payload: { ...current.payload, ...patch } as MessagePayload,
      })
    } catch (err) {
      this.deps.log?.('warn', 'user request card update failed', { err: errorMessage(err) })
      return null
    }
  }

  private expire(row: UserRequestRow, reason: UserRequestExpiredReason): void {
    this.requests.mark(row.id, 'expired')
    this.updateCard(row, { status: 'expired', expiredReason: reason })
  }

  /** The bot was deleted: its pending requests expire and a waiting tool call stops. */
  botDeleted(botId: string): void {
    for (const row of this.requests.pending()) {
      if (row.bot_id !== botId) continue
      this.expire(row, 'bot_deleted')
      this.waiters.get(row.id)?.reject(stopped())
    }
  }

  /**
   * Hands the answer to the waiting tool call; after it stopped waiting (timeout, runtime restart) the bot
   * gets a new turn in the card's conversation with the answer as a note.
   */
  private deliver(row: UserRequestRow, resolution: Resolution, lateNote: string): void {
    const waiter = this.waiters.get(row.id)
    if (waiter) {
      waiter.resolve(resolution)
      return
    }
    if (!this.deps.store.bots.find(row.bot_id)) return
    this.deps.host.enqueueTurn({
      botId: row.bot_id,
      conversationId: row.conversation_id,
      trigger: 'user_answer',
      note: lateNote,
    })
  }

  answerQuestion(requestId: string, body: z.output<typeof AnswerQuestionBody>): Message {
    const row = this.requests.row(requestId)
    if (row.kind !== 'question') throw new DaemonError('validation_failed', 'This request is not a question')
    if (row.status !== 'pending') return this.card(row)
    const { questions } = parseJson<QuestionParams>(row.params, { questions: [] })
    if (body.answers.length !== questions.length)
      throw new DaemonError('validation_failed', `Expected ${questions.length} answers`)
    const answers = body.answers.map((answer, i) => {
      const question = questions[i] as UserQuestion
      const labels = question.options.map((o) => o.label)
      const selected = [...new Set(answer.selected)]
      if (selected.some((label) => !labels.includes(label)))
        throw new DaemonError('validation_failed', `Unknown option in answer ${i + 1}`)
      if (!question.multiSelect && selected.length > 1)
        throw new DaemonError('validation_failed', `Question ${i + 1} takes one option`)
      const other = answer.other?.trim()
      if (!selected.length && !other) throw new DaemonError('validation_failed', `Answer ${i + 1} is empty`)
      return { selected, ...(other ? { other } : {}) }
    })
    this.requests.mark(row.id, 'answered', { answers })
    const card = this.updateCard(row, { status: 'answered', answers }, questionContent(questions, answers))
    this.deliver(
      row,
      { status: 'answered', answers },
      `[Milibot] The user answered the question you asked earlier (ask_user).\n\n${questionResultText(questions, answers)}`,
    )
    return card ?? this.card(row)
  }

  async answerSecret(requestId: string, body: z.output<typeof AnswerSecretBody>): Promise<Message> {
    const { credentials } = this.deps
    const row = this.requests.row(requestId)
    if (row.kind !== 'secret') throw new DaemonError('validation_failed', 'This request is not a secret')
    if (row.status !== 'pending' || this.resolving.has(row.id)) return this.card(row)
    const bot = this.deps.store.bots.find(row.bot_id)
    if (!bot) {
      this.expire(row, 'bot_deleted')
      return this.card(row)
    }
    const params = parseJson<SecretParams>(row.params, NO_SECRET)
    const remember = params.asEnv || body.remember
    this.resolving.add(row.id)
    try {
      if (remember) {
        const existing = credentials.findSecret(params.name)
        const scope: EnvSecretScope =
          body.scope === 'all' || existing?.scope === 'all'
            ? 'all'
            : [...new Set([...(existing?.scope ?? []), bot.id])]
        if (existing)
          await credentials.updateEnvSecret(existing.id, {
            value: body.value,
            scope,
            exposeAsEnv: params.asEnv || existing.exposeAsEnv,
            label: existing.label ?? params.label,
          })
        else
          await credentials.createEnvSecret({
            name: params.name,
            value: body.value,
            scope,
            exposeAsEnv: params.asEnv,
            label: params.label,
          })
      } else {
        credentials.setTemporarySecret({
          name: params.name,
          label: params.label,
          scope: body.scope === 'all' ? 'all' : [bot.id],
          value: body.value,
        })
      }
      await credentials.syncSecretFiles()
    } finally {
      this.resolving.delete(row.id)
    }
    this.requests.mark(row.id, 'answered')
    const card = this.updateCard(row, { status: 'answered', remember, scope: body.scope })
    const resolution: Resolution = { status: 'provided', remember, scope: body.scope }
    this.deliver(
      row,
      resolution,
      `[Milibot] Answer to your earlier request_secret: ${secretOutcomeText(params, resolution)}`,
    )
    return card ?? this.card(row)
  }

  decline(requestId: string): Message {
    const row = this.requests.row(requestId)
    if (row.status !== 'pending' || this.resolving.has(row.id)) return this.card(row)
    this.requests.mark(row.id, 'declined')
    const card = this.updateCard(row, { status: 'declined' })
    const resolution: Resolution = { status: 'declined' }
    const note =
      row.kind === 'secret'
        ? `[Milibot] Answer to your earlier request_secret: ${secretOutcomeText(
            parseJson<SecretParams>(row.params, NO_SECRET),
            resolution,
          )}`
        : `[Milibot] About the question you asked earlier (ask_user): ${questionOutcomeText([], resolution)}`
    this.deliver(row, resolution, note)
    return card ?? this.card(row)
  }

  /**
   * The user wrote in a conversation with a pending question: that message answers it. Returns true when a
   * waiting tool call took it (the message must not start another turn of the same bot).
   */
  answerFromChat(message: Message): boolean {
    if (message.authorType !== 'user') return false
    let taken = false
    for (const row of this.requests.pending(message.conversationId)) {
      if (row.kind !== 'question') continue
      this.requests.mark(row.id, 'answered_in_chat', { inChat: message.content })
      this.updateCard(row, { status: 'answered_in_chat' })
      const waiter = this.waiters.get(row.id)
      if (!waiter) continue
      waiter.resolve({ status: 'answered_in_chat', text: message.content })
      taken = true
    }
    return taken
  }

  handlers(): EndpointHandlers<UserRequestEndpoint> {
    return {
      answerSecretRequest: ({ params, body }) => this.answerSecret(params.requestId, body),
      answerQuestion: ({ params, body }) => this.answerQuestion(params.requestId, body),
      declineUserRequest: ({ params }) => this.decline(params.requestId),
    }
  }
}
