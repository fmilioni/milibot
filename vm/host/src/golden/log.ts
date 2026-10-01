const pad2 = (n: number) => String(n).padStart(2, '0')

/** `[build HH:MM:SS] …` on stderr: the lines the daemon's golden/progress.ts reads. */
export function log(message: string): void {
  const d = new Date()
  process.stderr.write(
    `[build ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}] ${message}\n`,
  )
}

/** An expected failure: reported as its message, without a stack. */
export class BuildError extends Error {}

export function utcVersion(date = new Date()): string {
  return (
    String(date.getUTCFullYear()) +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes())
  )
}
