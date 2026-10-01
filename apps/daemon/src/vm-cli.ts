import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VmCliErrorBody } from '@milibot/shared'
import { qemuIdentity, vmRootDir } from '@milibot/vm-host'
import type { z } from 'zod'

import { findUp } from './util/fs'
import { sha256 } from './util/hash'

export { vmRootDir }

export class VmCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'VmCliError'
  }
}

export interface VmCli {
  run(args: string[], options?: { timeoutMs?: number }): Promise<Record<string, unknown>>
  /**
   * Whether `pid` (from `qemu.pid`) is the VM's process and not an unrelated one that reused a stale pid;
   * without it any live pid counts.
   */
  isVmProcess?(pid: number): boolean
}

/** `relative` found upwards from this module (the repository in dev and tests), unless overridden. */
export function findRepoFile(relative: string, override: string | null, envVar: string): string {
  if (override) return override
  const found = findUp(dirname(fileURLToPath(import.meta.url)), relative)
  if (!found) throw new Error(`${relative.split(/[\\/]/).join('/')} not found; set ${envVar}`)
  return found
}

/**
 * How to run a VM script: a `.ts` (sources, stripped by Node itself), `.mjs` or `.js` on this process's Node
 * (no shell, works on Windows), a `.sh` (fakes, the manual shortcuts) on bash, anything else directly.
 */
export function scriptCommand(script: string): { command: string; args: string[] } {
  if (/\.(m?js|ts)$/.test(script)) return { command: process.execPath, args: [script] }
  if (script.endsWith('.sh')) return { command: 'bash', args: [script] }
  return { command: script, args: [] }
}

/** `vm/host/src/cli/workspace-vm.ts` (`MILIBOT_VM_CLI` overrides it; the packaged app points it at its bundle). */
export function defaultVmScript(override: string | null): string {
  return findRepoFile(join('vm', 'host', 'src', 'cli', 'workspace-vm.ts'), override, 'MILIBOT_VM_CLI')
}

/** Validates a command's output against its contract schema. */
export function parseVmCliOutput<S extends z.ZodType>(schema: S, output: unknown): z.output<S> {
  const parsed = schema.safeParse(output)
  if (!parsed.success)
    throw new VmCliError(
      'VM_CLI_INVALID_OUTPUT',
      `unexpected VM CLI output: ${parsed.error.message.slice(0, 500)}`,
    )
  return parsed.data
}

export interface GuestAgentBundle {
  /** First 16 hex chars of the sha256 (what the agent reports as `agentSha`). */
  sha: string
  content: string
}

/** `vm/guest-agent/dist/guest-agent.mjs` next to the VM script (bundled in the app's Resources/vm). */
export function loadGuestAgentBundle(vmScript: string): GuestAgentBundle | null {
  try {
    const bytes = readFileSync(join(vmRootDir(vmScript), 'guest-agent', 'dist', 'guest-agent.mjs'))
    return {
      sha: sha256(bytes).slice(0, 16),
      content: bytes.toString('utf8'),
    }
  } catch {
    return null
  }
}

/**
 * Runs the VM CLI, which prints one JSON object (errors: `{ok:false,error:{code,message}}`). A live pid only
 * counts as the VM when it is a QEMU process (or its name can't be read), like the script itself checks.
 */
export function createShellVmCli(script: string, env: NodeJS.ProcessEnv = process.env): VmCli {
  const { command, args: prefix } = scriptCommand(script)
  return {
    isVmProcess: (pid) => qemuIdentity(pid) !== 'no',
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        execFile(
          command,
          [...prefix, ...args],
          { env, timeout: options.timeoutMs ?? 300_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            let parsed: Record<string, unknown> | null
            try {
              parsed = JSON.parse(stdout) as Record<string, unknown>
            } catch {
              parsed = null
            }
            const failure = VmCliErrorBody.safeParse(parsed)
            if (failure.success)
              return reject(new VmCliError(failure.data.error.code, failure.data.error.message))
            if (parsed?.ok === false) return reject(new VmCliError('VM_CLI_FAILED', 'VM command failed'))
            if (error || !parsed) {
              return reject(
                new VmCliError(
                  'VM_CLI_FAILED',
                  (stderr || error?.message || 'invalid VM CLI output').trim().slice(0, 2000),
                ),
              )
            }
            resolve(parsed)
          },
        )
      })
    },
  }
}
