import { type ExecResult, type GuestExecRequest, type LogFn, slugify, type SshKeyInfo } from '@milibot/shared'

import { SSH_KEY_SCRIPT } from './scripts/ssh-key.generated'

const SSH_KEY_SETTING = 'ssh.public_key'

export interface SshKeyDeps {
  workspaceName: () => string
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  exec: () => ((request: GuestExecRequest) => Promise<ExecResult>) | null
  log?: LogFn
}

/** The VM's SSH key (made once in the VM as `agent`); the public key is cached for when the VM is off. */
export class SshKey {
  constructor(private readonly deps: SshKeyDeps) {}

  async info(): Promise<SshKeyInfo> {
    const cached = this.deps.getSetting<string | null>(SSH_KEY_SETTING, null)
    const exec = this.deps.exec()
    if (!exec) return { publicKey: cached, vmRunning: false }
    const comment = `milibot@${slugify(this.deps.workspaceName(), { fallback: 'workspace' })}`
    const result = await exec({
      user: 'agent',
      cmd: SSH_KEY_SCRIPT,
      cwd: '/tmp',
      env: { KEY_COMMENT: comment },
      timeoutMs: 30_000,
    })
    const publicKey = result.stdout.trim().split('\n').at(-1) ?? ''
    if (result.code !== 0 || !publicKey.startsWith('ssh-')) {
      this.deps.log?.('warn', 'could not read the VM SSH key', { stderr: result.stderr.slice(0, 300) })
      return { publicKey: cached, vmRunning: true }
    }
    if (publicKey !== cached) this.deps.setSetting(SSH_KEY_SETTING, publicKey)
    return { publicKey, vmRunning: true }
  }
}
