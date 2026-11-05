import { spawn } from 'node:child_process'

import { DaemonError } from '../../errors'
import { FETCH_EXEC_MAX_OUTPUT, FETCH_EXEC_TIMEOUT_MS } from './limits'
import { FETCH_SCRIPT } from './scripts/fetch.generated'
import { LOCAL_ONLY_WITHOUT_COMPUTER } from './url-policy'
import { fetchScriptInput, parseFetchOutput, type VmFetchRequest, type VmFetchResult } from './vm-fetch'

/**
 * Downloads `request.url` with the VM's fetch script run by the daemon's own Node: how a workspace without a
 * computer reads the web. Same blocked addresses, limits and output as in the VM.
 */
export async function fetchOnHost(
  request: VmFetchRequest,
  signal: AbortSignal,
  allowPrivate = false,
): Promise<VmFetchResult> {
  const timeout = AbortSignal.timeout(FETCH_EXEC_TIMEOUT_MS)
  const output = await runScript(fetchScriptInput(request, allowPrivate), AbortSignal.any([signal, timeout]))

  if (timeout.aborted) {
    throw new DaemonError('validation_failed', 'Could not fetch the page (timeout)')
  }

  signal.throwIfAborted()

  return parseFetchOutput(output.stdout, output.stderr, LOCAL_ONLY_WITHOUT_COMPUTER)
}

function runScript(stdin: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', FETCH_SCRIPT], { signal, windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > FETCH_EXEC_MAX_OUTPUT) {
        child.kill()
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.on('error', (err) => {
      if (signal.aborted) {
        resolve({ stdout: '', stderr: '' })
        return
      }
      reject(err)
    })
    child.on('close', () => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })

    child.stdin.end(stdin)
  })
}
