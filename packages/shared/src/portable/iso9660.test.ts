import { describe, expect, it } from 'vitest'

import { buildIso, primaryName } from './iso9660'

const SECTOR = 2048
const text = (s: string) => new TextEncoder().encode(s)

interface Entry {
  name: string
  extent: number
  size: number
}

/** Reads the root directory of the primary (1) or Joliet (2) descriptor. */
function readRoot(iso: Uint8Array, type: 1 | 2): { volumeId: string; entries: Entry[] } {
  const view = new DataView(iso.buffer, iso.byteOffset)
  let at = 16 * SECTOR
  while (iso[at] !== type) {
    if (iso[at] === 255) throw new Error('descriptor not found')
    at += SECTOR
  }
  const decode = (bytes: Uint8Array) =>
    type === 2 ? new TextDecoder('utf-16be').decode(bytes) : new TextDecoder().decode(bytes)
  const volumeId = decode(iso.subarray(at + 40, at + 72)).trim()
  const rootExtent = view.getUint32(at + 156 + 2, true)
  const rootSize = view.getUint32(at + 156 + 10, true)
  const entries: Entry[] = []
  let pos = rootExtent * SECTOR
  const end = pos + rootSize
  while (pos < end) {
    const length = iso[pos] as number
    if (length === 0) {
      pos = (Math.floor(pos / SECTOR) + 1) * SECTOR
      continue
    }
    const nameLength = iso[pos + 32] as number
    const name = iso.subarray(pos + 33, pos + 33 + nameLength)
    if (!(nameLength === 1 && (name[0] === 0 || name[0] === 1))) {
      entries.push({
        name: decode(name),
        extent: view.getUint32(pos + 2, true),
        size: view.getUint32(pos + 10, true),
      })
    }
    pos += length
  }
  return { volumeId, entries }
}

describe('buildIso', () => {
  const files = [
    { name: 'user-data', data: text('#cloud-config\nusers: []\n') },
    { name: 'meta-data', data: text('instance-id: x\n') },
    { name: 'payload.tgz', data: new Uint8Array(5000).map((_, i) => i % 251) },
    { name: 'empty', data: new Uint8Array() },
  ]

  it('writes a cidata volume with Joliet names and the file contents', () => {
    const iso = buildIso(files, { volumeId: 'cidata', date: new Date('2026-09-28T12:00:00Z') })
    expect(iso.length % SECTOR).toBe(0)
    expect(new TextDecoder().decode(iso.subarray(16 * SECTOR + 1, 16 * SECTOR + 6))).toBe('CD001')
    const joliet = readRoot(iso, 2)
    expect(joliet.volumeId).toBe('cidata')
    expect(joliet.entries.map((e) => e.name)).toEqual(['empty', 'meta-data', 'payload.tgz', 'user-data'])
    for (const file of files) {
      const entry = joliet.entries.find((e) => e.name === file.name)!
      expect(entry.size).toBe(file.data.length)
      expect(Array.from(iso.subarray(entry.extent * SECTOR, entry.extent * SECTOR + entry.size))).toEqual(
        Array.from(file.data),
      )
    }
    const primary = readRoot(iso, 1)
    expect(primary.entries.map((e) => e.name)).toEqual([
      'EMPTY.;1',
      'META_DATA.;1',
      'PAYLOAD.TGZ;1',
      'USER_DATA.;1',
    ])
    // Both trees share the file data.
    expect(primary.entries.find((e) => e.name === 'USER_DATA.;1')?.extent).toBe(
      joliet.entries.find((e) => e.name === 'user-data')?.extent,
    )
  })

  it('spreads a large root over several sectors', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      name: `file-${String(i).padStart(3, '0')}.txt`,
      data: text(`${i}`),
    }))
    const iso = buildIso(many, { volumeId: 'cidata' })
    expect(readRoot(iso, 2).entries).toHaveLength(80)
    expect(readRoot(iso, 1).entries).toHaveLength(80)
  })

  it('rejects folders and collisions', () => {
    expect(() => buildIso([{ name: 'a/b', data: new Uint8Array() }], { volumeId: 'x' })).toThrow(/invalid/)
    expect(() =>
      buildIso(
        [
          { name: 'a-b', data: new Uint8Array() },
          { name: 'a_b', data: new Uint8Array() },
        ],
        { volumeId: 'x' },
      ),
    ).toThrow(/collision/)
    expect(primaryName('meta-data')).toBe('META_DATA.;1')
  })
})
