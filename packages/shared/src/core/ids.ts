const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

let lastTime = -1
let lastRandom: number[] = []

function randomChars(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b % 32)
}

function incrementRandom(chars: number[]): number[] {
  const next = [...chars]
  for (let i = next.length - 1; i >= 0; i--) {
    const value = next[i] ?? 0
    if (value < 31) {
      next[i] = value + 1
      return next
    }
    next[i] = 0
  }
  return randomChars()
}

function encodeTime(time: number): string {
  let out = ''
  let remaining = time
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[remaining % 32] + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

/** Monotonic ULID: lexicographic order matches creation order within a process. */
export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = incrementRandom(lastRandom)
  } else {
    lastTime = now
    lastRandom = randomChars()
  }
  return encodeTime(lastTime) + lastRandom.map((c) => ENCODING[c]).join('')
}

export const ID_PREFIXES = {
  workspace: 'ws',
  bot: 'bot',
  provider: 'prv',
  providerModel: 'pm',
  conversation: 'cnv',
  message: 'msg',
  attachment: 'att',
  summary: 'sum',
  memory: 'mem',
  procedure: 'prc',
  procedureStep: 'prs',
  skill: 'skill',
  llmCall: 'llm',
  toolCall: 'tc',
  sidebarSection: 'sec',
  routine: 'rtn',
  worktree: 'wt',
  turn: 'trn',
  confirmation: 'cfm',
  botRequest: 'brq',
  mcpServer: 'mcp',
  envSecret: 'sec',
  promptVersion: 'pv',
  backup: 'bkp',
  knowledgeDoc: 'kdoc',
  knowledgeUpload: 'kup',
  userRequest: 'ureq',
  project: 'prj',
  plan: 'plan',
  todo: 'todo',
  workSession: 'wses',
  sessionSummary: 'ssum',
  design: 'dsg',
  designFrame: 'dfr',
  designRevision: 'drev',
  board: 'brd',
  boardCard: 'bcd',
  boardComment: 'bcm',
  boardLink: 'blk',
  boardUpload: 'bup',
  boardLabel: 'blb',
} as const

export type IdKind = keyof typeof ID_PREFIXES

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid().toLowerCase()}`
}
