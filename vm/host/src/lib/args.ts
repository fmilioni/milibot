export type Flags = Record<string, string | true>

export interface ParsedArgs {
  positional: string[]
  flags: Flags
}

/** `--key=value`, `--key value` and bare `--key` (true); `-h` is `--help`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '-h') flags.help = true
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      const next = argv[i + 1]
      if (eq !== -1) flags[key] = arg.slice(eq + 1)
      else if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else flags[key] = true
    } else positional.push(arg)
  }
  return { positional, flags }
}

/** A failure with a stable code; `exitCode` 2 marks usage errors. */
export class CliError extends Error {
  readonly code: string
  readonly exitCode: number
  constructor(code: string, message: string, exitCode = 1) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}

export const usage = (message: string): CliError => new CliError('USAGE', message, 2)

export function intFlag(
  flags: Flags,
  name: string,
  { min = 1, max = Infinity, fallback }: { min?: number; max?: number; fallback?: number } = {},
): number {
  const raw = flags[name]
  if (raw === undefined || raw === true) {
    if (fallback === undefined) throw usage(`--${name} is required`)
    return fallback
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max)
    throw usage(`--${name} must be an integer in ${min}..${max}`)
  return n
}

export function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

/** Rejects flags the command doesn't know (typos would otherwise be ignored silently). */
export function allowFlags(flags: Flags, allowed: readonly string[]): void {
  const unknown = Object.keys(flags).filter((key) => !allowed.includes(key))
  if (unknown.length) throw usage(`unknown option: --${unknown[0]}`)
}
