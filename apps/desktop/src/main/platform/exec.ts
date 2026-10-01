import { execFile } from 'node:child_process'

/** One argument for a POSIX shell. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Runs the command with `args`; never rejects (a command that could not run reports code 1). */
export type CommandRunner = (args: string[]) => Promise<{ code: number; stdout: string }>

export function commandRunner(file: string, timeoutMs = 10_000): CommandRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, stdout: String(stdout) })
      })
    })
}
