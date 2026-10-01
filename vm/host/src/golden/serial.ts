import fs from 'node:fs'

export interface SerialResult {
  rc: number | null
  manifest: Record<string, unknown> | null
}

/** Result markers the guest prints on the serial console (`vm/guest/build-runner.sh`). */
export function parseSerial(text: string): SerialResult {
  const rcs = [...text.matchAll(/MILIBOT_BUILD_RC=(\d+)/g)]
  const last = rcs.at(-1)
  const rc = last ? Number(last[1]) : null
  const m = /MILIBOT_MANIFEST_BEGIN([\s\S]*?)MILIBOT_MANIFEST_END/.exec(text)
  let manifest: Record<string, unknown> | null = null
  if (m?.[1]) {
    try {
      manifest = JSON.parse(
        Buffer.from(m[1].replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'),
      ) as Record<string, unknown>
    } catch {
      manifest = null
    }
  }
  return { rc, manifest }
}

/** The newest `[provision …]` line of the serial log. */
export function lastProvisionLine(serialFile: string): string | null {
  let text: string
  try {
    text = fs.readFileSync(serialFile, 'latin1')
  } catch {
    return null
  }
  const lines = text.split('\n').filter((l) => l.includes('[provision '))
  return lines.at(-1)?.replace(/\r/g, '').trim() ?? null
}
