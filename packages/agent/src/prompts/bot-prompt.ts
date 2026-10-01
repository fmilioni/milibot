import { estimateTokens, type Language, PERSONA_MAX_TOKENS } from '@milibot/shared'

import { LANGUAGE_NAMES } from './language'

export interface BotPromptInput {
  name: string
  label: string
  description: string
  language: Language
}

export interface BotPromptRequest {
  system: string
  prompt: string
  maxOutputTokens: number
}

/** Target size of the generated role; the hard cap (PERSONA_MAX_TOKENS) leaves room for the user's edits. */
const BOT_PROMPT_TARGET_WORDS = 550

export function botPromptSystem(language: Language): string {
  const lang = LANGUAGE_NAMES[language]
  return `You write the role section of the system prompt of a new specialist bot in Milibot, a team of AI bots working for one user. Each bot has its own Linux desktop in a shared Debian VM (shared files in /workspace), can run commands, edit files, browse the web, use apps and talk to the user and to the other bots. The general rules (tools, memory, safety, team list) are added separately: do not repeat them.

Turn the user's description into a complete, specific role, as good as a senior manager would write for a new hire:
- Identity and mission: who the bot is (by name) and the outcome it owns, in one or two sentences.
- Responsibilities: what it takes care of day to day, and what it hands back to the user or to the bot that coordinates the team instead of doing.
- Working method: concrete steps and quality standards for this domain (e.g. code: read before changing, small commits on its own branch, run the tests; research: cite sources, separate facts from estimates; content: drafts for approval before publishing; finance: show the calculations, keep spreadsheets in /workspace/<project>).
- Output style: format, length and tone of its answers and deliverables, where files go and how it reports back (short summary + where the files are).
- When to ask: what it must confirm with the user first (destructive, public or paid actions, unclear priorities) and when to proceed on sensible assumptions, stating them.

Rules:
- Write the whole text in ${lang}, addressing the bot as "you", in Markdown with short headings and bullet points.
- Use only facts from the description. Never invent names, accounts, tools, clients or deadlines; where something is unknown, tell the bot to ask the user or find out.
- At most ${BOT_PROMPT_TARGET_WORDS} words.
- Reply with the role section only, inside <system_prompt>…</system_prompt>, with nothing before or after it.`
}

export function botPromptRequest(
  input: BotPromptInput,
  previous?: { text: string; tokens: number },
): BotPromptRequest {
  const lines = [
    `Bot name: ${input.name.trim() || '(not chosen yet)'}`,
    `Role label: ${input.label.trim() || '(none)'}`,
    '',
    'What the user wants this bot to do:',
    '<description>',
    input.description.trim(),
    '</description>',
  ]
  if (previous) {
    lines.push(
      '',
      `Your previous version was about ${previous.tokens} tokens, over the limit of ${PERSONA_MAX_TOKENS}. ` +
        `Rewrite it in at most ${Math.round(BOT_PROMPT_TARGET_WORDS * 0.7)} words, keeping every section but with fewer words:`,
      '<previous>',
      previous.text,
      '</previous>',
    )
  }
  return { system: botPromptSystem(input.language), prompt: lines.join('\n'), maxOutputTokens: 2_500 }
}

/** The role inside `<system_prompt>` (tolerates a missing closing tag or a code fence). */
export function parseGeneratedPrompt(text: string): string {
  let body = text.trim()
  const open = body.indexOf('<system_prompt>')
  if (open >= 0) {
    body = body.slice(open + '<system_prompt>'.length)
    const close = body.indexOf('</system_prompt>')
    if (close >= 0) body = body.slice(0, close)
  }
  body = body.trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(body)
  if (fence?.[1]) body = fence[1].trim()
  return body
}

/** Drops whole trailing paragraphs (then lines) until the text fits the persona cap. */
export function fitPersona(text: string, maxTokens = PERSONA_MAX_TOKENS): string {
  if (estimateTokens(text) <= maxTokens) return text
  const paragraphs = text.split(/\n{2,}/)
  while (paragraphs.length > 1 && estimateTokens(paragraphs.join('\n\n')) > maxTokens) paragraphs.pop()
  let result = paragraphs.join('\n\n')
  if (estimateTokens(result) <= maxTokens) return result
  const lines = result.split('\n')
  while (lines.length > 1 && estimateTokens(lines.join('\n')) > maxTokens) lines.pop()
  result = lines.join('\n')
  return estimateTokens(result) <= maxTokens ? result : result.slice(0, Math.floor(maxTokens * 3.5))
}

export interface GeneratedBotPrompt {
  systemPrompt: string
  tokens: number
  maxTokens: number
}

/**
 * Generates a persona with a cheap one-shot model (`write`); asks once for a shorter version when it
 * comes back over the cap, then trims whole paragraphs as a last resort.
 */
export async function generateBotPrompt(
  input: BotPromptInput,
  write: (request: BotPromptRequest) => Promise<string>,
): Promise<GeneratedBotPrompt> {
  let text = parseGeneratedPrompt(await write(botPromptRequest(input)))
  if (!text) throw new Error('The model returned an empty prompt')
  const tokens = estimateTokens(text)
  if (tokens > PERSONA_MAX_TOKENS) {
    const shorter = parseGeneratedPrompt(await write(botPromptRequest(input, { text, tokens })))
    if (shorter) text = shorter
    text = fitPersona(text)
  }
  return { systemPrompt: text, tokens: estimateTokens(text), maxTokens: PERSONA_MAX_TOKENS }
}
