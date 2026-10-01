import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { GUEST_AGENT_PORT } from '@milibot/shared/portable/platform'

import { TokenSource } from './auth.ts'
import { ensureClaudeSettings } from './claude-settings.ts'
import { ensureClaudeWrapper } from './claude-wrapper.ts'
import { createOfficeInstaller } from './extract/libreoffice.ts'
import { createExtractTools } from './extract/tools.ts'
import { ensureGuestFile, GUEST_FILES } from './guest-files.ts'
import { ProcessManager } from './procs.ts'
import { createAgentServer } from './routes.ts'

const VERSION = process.env.GUEST_AGENT_VERSION ?? 'dev'
const PORT = Number(process.env.MILIBOT_AGENT_PORT ?? GUEST_AGENT_PORT)
const HOST = process.env.MILIBOT_AGENT_HOST ?? '0.0.0.0'
const TOKEN_FILE = process.env.MILIBOT_AGENT_TOKEN_FILE ?? '/etc/milibot/agent.token'

/** Same short hash as the image manifest's `guestAgentSha`: the daemon compares it with the bundle it ships. */
function ownSha(): string | null {
  try {
    return createHash('sha256')
      .update(readFileSync(process.argv[1] ?? ''))
      .digest('hex')
      .slice(0, 16)
  } catch {
    return null
  }
}

function ensure(name: string, run: () => string): void {
  try {
    const result = run()
    if (result !== 'unchanged') console.log(`${name}: ${result}`)
  } catch (err) {
    console.error(`${name}: ${(err as Error).message}`)
  }
}

process.umask(0o002)
ensure('claude wrapper', () => ensureClaudeWrapper())
for (const file of GUEST_FILES) ensure(file.path, () => ensureGuestFile(file))
ensure('claude settings', () => ensureClaudeSettings())

const tokens = new TokenSource(TOKEN_FILE)
const server = createAgentServer({
  token: () => tokens.get(),
  agentSha: ownSha(),
  procs: new ProcessManager(),
  extractTools: createExtractTools(),
  office: createOfficeInstaller(),
})
server.listen(PORT, HOST, () => console.log(`milibot guest agent ${VERSION} listening on ${HOST}:${PORT}`))
