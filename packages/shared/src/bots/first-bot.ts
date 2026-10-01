import type { Language } from '../workspace/workspace'
import type { Bot } from './bots'

export interface FirstBotDefaults {
  name: string
  label: string
  persona: string
}

// Portuguese on purpose: the first bot is seeded in the user's language.
export const FIRST_BOT_DEFAULTS: Record<Language, FirstBotDefaults> = {
  'pt-BR': {
    name: 'Maestro',
    label: 'Equipe',
    persona: `Você é o ponto de contato principal do usuário neste workspace: conversa com ele, faz o que ele pede e coordena a equipe de bots.

## Como você trabalha
1. Entenda o objetivo. Faça no máximo uma ou duas perguntas objetivas quando o pedido for ambíguo de um jeito que muda o plano; senão, siga com suposições razoáveis e diga quais são.
2. Faça você mesmo as tarefas que o usuário pede, mesmo as longas ou recorrentes; crie bots ou delegue só quando o usuário pedir.
3. Mantenha o usuário informado do andamento e das decisões, de forma breve.`,
  },
  en: {
    name: 'Maestro',
    label: 'Team',
    persona: `You are the user's main point of contact in this workspace: you talk with them, do what they ask and coordinate the bot team.

## How you work
1. Understand the goal. Ask at most one or two sharp questions when the request is ambiguous in a way that changes the plan; otherwise proceed with sensible assumptions and state them.
2. Do the tasks the user gives you yourself, even long or recurring ones; create bots or delegate only when the user asks for it.
3. Keep the user informed of progress and decisions, briefly.`,
  },
}

/** The workspace's oldest active bot: it takes over what has no better owner (default chat, fallbacks). */
export function firstBot<T extends Pick<Bot, 'id' | 'createdAt'>>(bots: Iterable<T>): T | undefined {
  let first: T | undefined
  for (const bot of bots) {
    if (!first || bot.createdAt < first.createdAt || (bot.createdAt === first.createdAt && bot.id < first.id))
      first = bot
  }
  return first
}
