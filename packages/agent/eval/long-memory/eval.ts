import { foldText } from '@milibot/shared'
import { OPENROUTER_BASE_URL } from '@milibot/shared'

import { DefaultAgentHost } from '../../src/host/agent-host'
import { AnthropicProvider } from '../../src/llm/anthropic'
import { FakeProvider, type FakeStep } from '../../src/llm/fake'
import { OpenAICompatibleProvider } from '../../src/llm/openai-compatible'
import { anthropicPrices } from '../../src/llm/pricing'
import type { CompletionRequest, LLMProvider } from '../../src/llm/provider'
import { RETRIEVED_HEADER } from '../../src/memory/context-builder'
import { SUMMARY_SYSTEM_PROMPT } from '../../src/prompts/summaries'
import { makeBot, TestEnv } from '../../src/test-support/env'

interface Fact {
  statement: string
  question: string
  answer: string
}

// Portuguese on purpose: the eval measures recall over a pt-BR conversation.
const FACTS: Fact[] = [
  {
    statement: 'Pra você saber: meu cachorro se chama Biscoito.',
    question: 'Qual é o nome do meu cachorro?',
    answer: 'Biscoito',
  },
  {
    statement: 'Anota aí: o IP do servidor de produção é 10.42.7.19.',
    question: 'Qual é o IP do servidor de produção?',
    answer: '10.42.7.19',
  },
  {
    statement: 'O codinome do projeto novo é Tangerina Azul.',
    question: 'Qual é o codinome do projeto novo?',
    answer: 'Tangerina Azul',
  },
  {
    statement: 'Minha reunião semanal com a Dra. Helena Prado é toda quinta às 15h.',
    question: 'Com quem é a minha reunião semanal de quinta às 15h?',
    answer: 'Helena',
  },
  {
    statement: 'Meu voo para Lisboa é o TP 1024, saindo de Guarulhos.',
    question: 'Qual é o número do meu voo para Lisboa?',
    answer: '1024',
  },
  {
    statement: 'Prefiro planilhas no LibreOffice Calc, nunca no Google Sheets.',
    question: 'Em qual programa eu prefiro fazer planilhas?',
    answer: 'LibreOffice',
  },
  {
    statement: 'O orçamento aprovado para a reforma da cozinha é de R$ 38.500.',
    question: 'Qual é o orçamento aprovado para a reforma da cozinha?',
    answer: '38.500',
  },
  {
    statement: 'Minha filha Clara faz aniversário no dia 12 de março.',
    question: 'Em que dia é o aniversário da Clara?',
    answer: '12 de março',
  },
]

const TOPICS: Array<{ subject: string; words: string[] }> = [
  { subject: 'receitas', words: ['farinha', 'forno', 'massa', 'tempero', 'molho', 'assado', 'panela'] },
  { subject: 'viagens', words: ['roteiro', 'hotel', 'trem', 'museu', 'bagagem', 'passeio', 'praia'] },
  { subject: 'programação', words: ['função', 'teste', 'deploy', 'branch', 'refatoração', 'API', 'log'] },
  { subject: 'jardinagem', words: ['muda', 'adubo', 'rega', 'vaso', 'poda', 'semente', 'sol'] },
  { subject: 'finanças', words: ['fatura', 'investimento', 'juros', 'extrato', 'meta', 'reserva', 'boleto'] },
  { subject: 'filmes', words: ['diretor', 'roteiro', 'trilha', 'elenco', 'cena', 'estreia', 'crítica'] },
]

function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function fillerMessage(rand: () => number, i: number): string {
  const topic = TOPICS[Math.floor(rand() * TOPICS.length)] as (typeof TOPICS)[number]
  const pick = () => topic.words[Math.floor(rand() * topic.words.length)] as string
  const sentences = Array.from(
    { length: 5 + Math.floor(rand() * 5) },
    () => `Sobre ${topic.subject}, pensei em ${pick()} com ${pick()} e talvez ${pick()} depois.`,
  )
  return `(${i}) ${sentences.join(' ')} O que você acha?`
}

const found = (haystack: string, needle: string) => foldText(haystack).includes(foldText(needle))

function requestText(request: CompletionRequest): string {
  return request.messages
    .flatMap((m) => m.content)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n')
}

/**
 * Deterministic stand-in for a model. Summaries are extractive (first words of each line); for a
 * question it answers only if the fact is in its context (anywhere but the question), otherwise it
 * calls history_search once and answers from the result.
 */
function fakeModel(): LLMProvider {
  return new FakeProvider({
    // Simulated cost at Haiku 4.5 list prices, without prompt caching (an upper bound).
    prices: anthropicPrices('claude-haiku-4-5'),
    script: (request): FakeStep => {
      const first = request.messages[0]?.content[0]
      if (first?.type === 'text' && first.text === SUMMARY_SYSTEM_PROMPT) {
        const prompt = requestText(request)
        const lines = prompt
          .split('\n')
          .filter((l) => /^\[.*\] |<summary/.test(l) || l.startsWith('- '))
          .map((l) => `- ${l.replace(/^\[[^\]]*\] /, '').slice(0, 110)}`)
        return { text: lines.join('\n').split(' ').slice(0, 300).join(' ') || '- (nothing)' }
      }
      const last = request.messages.at(-1)
      const lastText = (last?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
      if (last?.role === 'tool') {
        const fact = FACTS.find((f) => found(requestText(request), f.question))
        return { text: fact && found(lastText, fact.answer) ? `Answer: ${fact.answer}` : 'Not found.' }
      }
      const question = lastText.split('\n').at(-1) ?? ''
      const fact = FACTS.find((f) => question.includes(f.question))
      if (!fact) return { text: 'Got it.' }
      const context = requestText(request).replace(fact.question, '')
      if (found(context, fact.answer)) return { text: `Answer: ${fact.answer}` }
      return { toolCalls: [{ name: 'history_search', arguments: { query: fact.question } }] }
    },
  })
}

function realModel(kind: string): { provider: LLMProvider; model: string } {
  if (kind === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required')
    return {
      provider: new OpenAICompatibleProvider({
        id: 'openrouter',
        baseUrl: OPENROUTER_BASE_URL,
        apiKey,
        preset: 'openrouter',
      }),
      model: process.env.EVAL_MODEL ?? 'anthropic/claude-haiku-4.5',
    }
  }
  if (kind === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required')
    return {
      provider: new AnthropicProvider({ id: 'anthropic', apiKey }),
      model: process.env.EVAL_MODEL ?? 'claude-haiku-4-5',
    }
  }
  throw new Error(`unknown EVAL_PROVIDER ${kind}`)
}

export interface EvalOptions {
  provider: 'fake' | 'openrouter' | 'anthropic'
  filler: number
  tailBudget: number
  seed: number
  /** Budget of the full-text retrieval section; 0 disables it (facts then come from summaries or history_search). */
  retrievedBudget?: number
}

export async function runLongMemoryEval(options: EvalOptions) {
  const kind = options.provider
  const fillerCount = options.filler
  const tailBudget = options.tailBudget
  const rand = prng(options.seed)
  const { provider, model } =
    kind === 'fake' ? { provider: fakeModel(), model: 'fake-model' } : realModel(kind)

  const env = new TestEnv(provider)
  env.resolveModel = async () => ({ kind: 'native', provider, providerId: kind, model })
  env.toolHandler = async () => ({ content: [{ type: 'text', text: 'ok' }] })
  const bot = makeBot({
    name: 'Iris',
    slug: 'iris',
    label: 'Assistente',
    systemPrompt: 'You are a helpful personal assistant.',
  })
  const conversation = env.addBot(bot)
  const host = new DefaultAgentHost({
    deltaFlushMs: 1,
    memory: {
      tailBudgetTokens: tailBudget,
      compactThresholdTokens: tailBudget,
      compactKeepTokens: tailBudget / 2,
      ...(options.retrievedBudget === undefined ? {} : { retrievedBudgetTokens: options.retrievedBudget }),
    },
  })
  await host.start(env)
  const say = async (text: string) => {
    host.onMessageCreated(env.userMessage(conversation.id, text))
    await host.idle(bot.id)
  }

  const started = Date.now()
  for (const fact of FACTS) await say(fact.statement)
  for (let i = 0; i < fillerCount; i++) await say(fillerMessage(rand, i))
  const results: Array<{ fact: Fact; reply: string; ok: boolean; inContext: boolean; usedTool: boolean }> = []
  for (const fact of FACTS) {
    const before = env.llmCalls.length
    const toolsBefore = env.toolCalls.size
    await say(fact.question)
    const reply =
      env.messages.filter((m) => m.authorType === 'bot' && m.kind === 'text').at(-1)?.content ?? ''
    const call = env.llmCalls.slice(before).find((c) => c.purpose === 'turn')
    const request = JSON.stringify(call?.request ?? '').replace(fact.question, '')
    results.push({
      fact,
      reply,
      ok: found(reply, fact.answer),
      inContext: found(request, fact.answer),
      usedTool: env.toolCalls.size > toolsBefore,
    })
  }
  await host.stop()

  const turns = FACTS.length * 2 + fillerCount
  const turnCalls = env.llmCalls.filter((c) => c.purpose === 'turn')
  const summaryCalls = env.llmCalls.filter((c) => c.purpose.startsWith('summary'))
  const cost = (calls: typeof env.llmCalls) => calls.reduce((s, c) => s + (c.usage.costUsd ?? 0), 0)
  const prompt = (c: (typeof env.llmCalls)[number]) =>
    c.usage.inputTokens + c.usage.cachedReadTokens + c.usage.cacheWriteTokens
  const lastCompositions = turnCalls.slice(-FACTS.length).map((c) => c.contextComposition)
  const avg = (key: Exclude<keyof NonNullable<(typeof lastCompositions)[number]>, 'mcpServers'>) =>
    Math.round(
      lastCompositions.reduce((s, c) => s + (c?.[key] ?? 0), 0) / Math.max(1, lastCompositions.length),
    )
  const report = {
    provider: kind,
    model,
    turns,
    tailBudget,
    retrievedBudget: options.retrievedBudget ?? null,
    accuracy: results.filter((r) => r.ok).length / results.length,
    answeredFromContext: results.filter((r) => r.inContext).length,
    usedHistorySearch: results.filter((r) => r.usedTool).length,
    llmCalls: { turn: turnCalls.length, summary: summaryCalls.length },
    summaries: {
      total: env.memory.summaries.length,
      active: env.memory.summaries.filter((s) => s.parentId === null).length,
      maxLevel: Math.max(0, ...env.memory.summaries.map((s) => s.level)),
    },
    retrievedInQuestions: results.filter((_, i) =>
      JSON.stringify(turnCalls.at(-FACTS.length + i)?.request ?? '').includes(RETRIEVED_HEADER.slice(0, 30)),
    ).length,
    promptTokensPerTurn: Math.round(turnCalls.reduce((s, c) => s + prompt(c), 0) / turns),
    lastTurnsComposition: {
      systemPrompt: avg('systemPrompt'),
      tools: avg('tools'),
      longTermMemory: avg('longTermMemory'),
      summaries: avg('summaries'),
      retrieved: avg('retrieved'),
      recentTail: avg('recentTail'),
    },
    costUsd: {
      total: cost(env.llmCalls),
      perTurn: cost(env.llmCalls) / turns,
      summaries: cost(summaryCalls),
    },
    seconds: Math.round((Date.now() - started) / 100) / 10,
    results: results.map((r) => ({
      question: r.fact.question,
      expected: r.fact.answer,
      ok: r.ok,
      inContext: r.inContext,
      usedTool: r.usedTool,
      reply: r.reply.slice(0, 200),
    })),
  }
  return report
}
