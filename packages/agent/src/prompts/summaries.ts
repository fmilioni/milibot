export const SUMMARY_SYSTEM_PROMPT = `You maintain the long-term memory of an AI assistant ("the bot") that chats with a user. You write compact, factual summaries of conversation transcripts. The bot will read your summary instead of the original messages, so keep everything it may need later:
- facts about the user, people, projects, preferences and decisions (keep exact names, numbers, dates, paths, URLs, IDs and commands);
- tasks: what was asked, what was done and where the results are, what is still pending;
- commitments the bot made and open questions.
Drop greetings, filler and anything superseded later in the transcript. Write in the language of the conversation, as terse bullet points grouped by topic, from the bot's perspective ("the user asked…", "I created…"). Output only the summary.`

export function conversationSummaryPrompt(transcript: string, previous: string | null): string {
  return [
    'Summarize this part of the conversation in at most about 250 words.',
    previous
      ? `For context only (it is already summarized; do not repeat it):\n<previous_summary>\n${previous}\n</previous_summary>`
      : '',
    `<transcript>\n${transcript}\n</transcript>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function summaryMergePrompt(parts: string[]): string {
  return [
    'Merge these consecutive summaries of one conversation (oldest first) into a single summary of at most about 350 words. Keep every durable fact (names, numbers, decisions, pending tasks); drop what later parts supersede.',
    ...parts.map((p, i) => `<summary part="${i + 1}">\n${p.trim()}\n</summary>`),
  ].join('\n\n')
}

/** Opens the rolling summary a compacted work session reads in place of its older context. */
export const SUMMARY_PREFIX = '[Milibot] Summary of the earlier part of this work session (compacted):'

export const SESSION_SUMMARY_SYSTEM = `You keep the running summary of a long work session of an AI agent, so it can go on after its older context is dropped. Write in English, as notes to the agent itself ("you did…"). Keep what it needs to continue and nothing else:
- the goal and any decisions or preferences the user stated in the session;
- what was done, with the files, commands, branches, URLs and identifiers involved;
- findings (how the code or system works, where things are) that are still useful;
- what failed, why, and what was tried;
- what is in progress and what is left.
Drop chatter, repeated attempts that led nowhere (keep only the lesson) and full tool outputs. Be dense: bullet points, at most ~1500 words.`

export function sessionSummaryPrompt(previous: string | null, rendered: string): string {
  return [
    previous?.trim() ? `Summary so far:\n${previous.trim()}` : null,
    `What happened next (to fold into the summary):\n${rendered}`,
    'Write the updated summary covering everything above.',
  ]
    .filter(Boolean)
    .join('\n\n')
}
