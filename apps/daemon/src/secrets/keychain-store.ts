import { execFile, spawn } from 'node:child_process'

import { ENTRY_ACCOUNT, IndexedEntrySecretStore } from './secret-store'

const ENCODED_PREFIX = 'b64:'
const ITEM_NOT_FOUND_EXIT = 44
const PLAIN_VALUE = /^[\x20-\x7E]*$/

/**
 * `security find-generic-password -w` prints non-printable data as hex, which is ambiguous with
 * hex-looking secrets. Anything that is not plain printable ASCII is therefore stored base64-encoded.
 */
export function encodeSecretValue(value: string): string {
  if (PLAIN_VALUE.test(value) && !value.startsWith(ENCODED_PREFIX)) return value
  return ENCODED_PREFIX + Buffer.from(value, 'utf8').toString('base64')
}

export function decodeSecretValue(stored: string): string {
  if (!stored.startsWith(ENCODED_PREFIX)) return stored
  return Buffer.from(stored.slice(ENCODED_PREFIX.length), 'base64').toString('utf8')
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`
}

/**
 * `security -i` reads commands in 4096-byte lines and runs whatever is past the limit as another command,
 * so each hex-encoded entry stays well under it (the rest of the line is the service name).
 */
const MAX_COMMAND_LINE = 4094
const MAX_ENTRY_HEX = 3000
/** Printable ASCII is stored as is: 2 hex digits per unit. */
const PLAIN_ENTRY_UNITS = MAX_ENTRY_HEX / 2
/** Anything else is base64 of UTF-8 (up to 3 bytes per unit): up to 8 hex digits per unit, plus the prefix. */
const ENCODED_ENTRY_UNITS = Math.floor((MAX_ENTRY_HEX - 2 * ENCODED_PREFIX.length) / 8)

export function keychainEntryUnits(value: string): number {
  const plain = PLAIN_VALUE.test(value) && !value.includes(ENCODED_PREFIX)
  return plain ? PLAIN_ENTRY_UNITS : ENCODED_ENTRY_UNITS
}

/** The `security -i` line that stores one entry, or null when it would not fit in one line. */
export function keychainAddCommand(service: string, value: string): string | null {
  const hex = Buffer.from(encodeSecretValue(value), 'utf8').toString('hex')
  const command = `add-generic-password -U -a ${quote(ENTRY_ACCOUNT)} -s ${quote(service)} -X ${hex}`
  return Buffer.byteLength(command) > MAX_COMMAND_LINE ? null : command
}

/** `security -i` echoes a misread command back; never let hex-encoded data reach an error message. */
function redactHex(text: string): string {
  return text.replace(/[0-9a-fA-F]{8,}/g, '…')
}

/**
 * macOS Keychain via the `security` CLI (no native module). Writes go through `security -i` on
 * stdin with hex-encoded data so secret values never appear in process arguments.
 */
export class KeychainSecretStore extends IndexedEntrySecretStore {
  constructor(private readonly securityBin = '/usr/bin/security') {
    super()
  }

  protected entryUnits(value: string): number {
    return keychainEntryUnits(value)
  }

  protected readEntry(service: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      execFile(
        this.securityBin,
        ['find-generic-password', '-a', ENTRY_ACCOUNT, '-s', service, '-w'],
        { windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            if (error.code === ITEM_NOT_FOUND_EXIT) resolve(null)
            else reject(new Error(`keychain read failed: ${stderr.trim() || error.message}`))
            return
          }
          resolve(decodeSecretValue(stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout))
        },
      )
    })
  }

  protected writeEntry(service: string, value: string): Promise<void> {
    const command = keychainAddCommand(service, value)
    if (command === null)
      return Promise.reject(new Error('keychain write failed: the entry does not fit in one command'))
    return new Promise((resolve, reject) => {
      const child = spawn(this.securityBin, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0 && !stderr.trim()) resolve()
        else reject(new Error(`keychain write failed: ${redactHex(stderr.trim()) || `exit ${code}`}`))
      })
      child.stdin.end(`${command}\n`)
    })
  }

  protected removeEntry(service: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        this.securityBin,
        ['delete-generic-password', '-a', ENTRY_ACCOUNT, '-s', service],
        { windowsHide: true },
        (error, _stdout, stderr) => {
          if (!error || error.code === ITEM_NOT_FOUND_EXIT) resolve()
          else reject(new Error(`keychain delete failed: ${stderr.trim() || error.message}`))
        },
      )
    })
  }
}
