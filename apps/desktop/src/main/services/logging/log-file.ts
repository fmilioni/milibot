import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export function formatLogEntry(at: Date, window: string, title: string, details: Array<string | undefined>) {
  const body = details.filter((d): d is string => Boolean(d?.trim())).map((d) => d.trimEnd())
  return [`[${at.toISOString()}] ${window} ${title}`, ...body].join('\n') + '\n\n'
}

export interface LogFs {
  size(file: string): number
  rename(from: string, to: string): void
  append(file: string, text: string): void
}

const nodeFs: LogFs = {
  size: (file) => {
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  },
  rename: (from, to) => renameSync(from, to),
  append: (file, text) => {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, text)
  },
}

/** Appends to `file`, first moving it to `<file>.1` (replacing the older one) once it passes `maxBytes`. */
export function appendRotating(file: string, text: string, maxBytes: number, fs: LogFs = nodeFs): void {
  if (fs.size(file) > maxBytes) fs.rename(file, `${file}.1`)
  fs.append(file, text)
}
