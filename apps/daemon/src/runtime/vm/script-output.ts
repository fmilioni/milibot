/** `KEY=VALUE` lines a guest script prints (upper-case keys, the last repeat wins); other lines are ignored. */
export function parseKeyValueLines(stdout: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z]+)=(.*)$/.exec(line.trim())
    if (match) values[match[1] as string] = match[2] as string
  }
  return values
}
