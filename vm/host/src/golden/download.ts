import { createHash } from 'node:crypto'
import fs from 'node:fs'

import { BuildError } from './log.ts'

const pad2 = (n: number) => String(n).padStart(2, '0')
const UNITS = ['', 'k', 'M', 'G', 'T']

/** curl's compact sizes (`350M`, `12.3M`); the daemon's golden/progress.ts parses them back. */
function curlSize(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 10_000 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  return `${text}${UNITS[unit]}`
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--:--'
  const s = Math.max(0, Math.round(seconds))
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`
}

/** One refresh of a curl-style meter (same 12 columns, `\r`-terminated). */
export function meterLine(received: number, total: number | null, elapsedSec: number): string {
  const percent = total ? Math.floor((received / total) * 100) : 0
  const speed = elapsedSec > 0 ? received / elapsedSec : 0
  const left = total && speed > 0 ? (total - received) / speed : NaN
  const cols = [
    percent,
    curlSize(total ?? 0),
    percent,
    curlSize(received),
    0,
    0,
    curlSize(speed),
    0,
    clock(total && speed > 0 ? total / speed : NaN),
    clock(elapsedSec),
    clock(left),
    curlSize(speed),
  ]
  return cols.join('  ')
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new BuildError(`GET ${url} -> HTTP ${res.status}`)
  return res.text()
}

/** The sha512 of `name` in a `SHA512SUMS` listing. */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const [sum, file] = line.trim().split(/\s+/)
    if (file === name && sum) return sum
  }
  return null
}

export function sha512File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

/** Streams `url` to `dest`, printing the meter about once a second; returns the sha512 of what was written. */
export async function download(url: string, dest: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new BuildError(`GET ${url} -> HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || null
  const hash = createHash('sha512')
  const out = fs.createWriteStream(dest)
  const started = Date.now()
  let received = 0
  let lastMeter = 0
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      received += chunk.length
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      if (Date.now() - lastMeter >= 1000) {
        lastMeter = Date.now()
        process.stderr.write(meterLine(received, total, (Date.now() - started) / 1000) + '\r')
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }
  process.stderr.write(meterLine(received, total ?? received, (Date.now() - started) / 1000) + '\n')
  if (total && received !== total)
    throw new BuildError(`download of ${url} ended early (${received}/${total} bytes)`)
  return hash.digest('hex')
}
