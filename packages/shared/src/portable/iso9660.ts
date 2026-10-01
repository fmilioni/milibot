/**
 * Minimal ISO 9660 writer with Joliet names, enough for a cloud-init NoCloud seed (volume `cidata`,
 * a flat root with `meta-data`, `user-data`, …). Pure (Uint8Array in, Uint8Array out, no Node
 * imports) so the VM scripts produce the same seed on every platform without external tools.
 */

export interface IsoFile {
  /** File name in the root directory (no folders). */
  name: string
  data: Uint8Array
}

export interface IsoOptions {
  volumeId: string
  /** Recording date of every record (default: now). */
  date?: Date
}

const SECTOR = 2048
const encoder = new TextEncoder()

function both16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
  view.setUint16(offset + 2, value, false)
}

function both32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true)
  view.setUint32(offset + 4, value, false)
}

function ascii(buf: Uint8Array, offset: number, length: number, text: string): void {
  buf.fill(0x20, offset, offset + length)
  buf.set(encoder.encode(text).subarray(0, length), offset)
}

function ucs2(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    out[i * 2] = code >> 8
    out[i * 2 + 1] = code & 0xff
  }
  return out
}

/** A Joliet text field: UCS-2 BE padded with U+0020. */
function ucs2Field(buf: Uint8Array, offset: number, length: number, text: string): void {
  for (let i = 0; i + 1 < length; i += 2) {
    buf[offset + i] = 0x00
    buf[offset + i + 1] = 0x20
  }
  buf.set(ucs2(text).subarray(0, length - (length % 2)), offset)
}

/** 17-byte "dec-datetime" of the volume descriptors (GMT). */
function decDate(buf: Uint8Array, offset: number, date: Date | null): void {
  if (!date) {
    buf.fill(0x30, offset, offset + 16)
    buf[offset + 16] = 0
    return
  }
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  const text =
    pad(date.getUTCFullYear(), 4) +
    pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) +
    pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) +
    pad(date.getUTCSeconds(), 2) +
    '00'
  buf.set(encoder.encode(text), offset)
  buf[offset + 16] = 0
}

/** 7-byte date of directory records. */
function recordDate(date: Date): number[] {
  return [
    date.getUTCFullYear() - 1900,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    0,
  ]
}

function dirRecord(name: Uint8Array, extent: number, size: number, isDir: boolean, date: Date): Uint8Array {
  const length = 33 + name.length + (name.length % 2 === 0 ? 1 : 0)
  const rec = new Uint8Array(length)
  const view = new DataView(rec.buffer)
  rec[0] = length
  both32(view, 2, extent)
  both32(view, 10, size)
  rec.set(recordDate(date), 18)
  rec[25] = isDir ? 2 : 0
  both16(view, 28, 1)
  rec[32] = name.length
  rec.set(name, 33)
  return rec
}

/** Records packed into sectors (a record never crosses a sector boundary). */
function directory(records: Uint8Array[]): Uint8Array {
  const chunks: number[] = []
  let sectors = 1
  let used = 0
  for (const rec of records) {
    if (used + rec.length > SECTOR) {
      sectors++
      used = 0
    }
    chunks.push((sectors - 1) * SECTOR + used)
    used += rec.length
  }
  const out = new Uint8Array(sectors * SECTOR)
  records.forEach((rec, i) => out.set(rec, chunks[i] as number))
  return out
}

/** Primary names: ISO 9660 d-characters (A-Z 0-9 _) with one dot and `;1`. */
export function primaryName(name: string): string {
  const upper = name.toUpperCase()
  const dot = upper.lastIndexOf('.')
  const clean = (s: string) => s.replace(/[^A-Z0-9_]/g, '_')
  const base = clean(dot > 0 ? upper.slice(0, dot) : upper).slice(0, 30) || '_'
  const ext = dot > 0 ? clean(upper.slice(dot + 1)).slice(0, 30 - Math.min(base.length, 30)) : ''
  return `${base}.${ext};1`
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number)
  }
  return a.length - b.length
}

export function buildIso(files: IsoFile[], options: IsoOptions): Uint8Array {
  const date = options.date ?? new Date()
  const names = new Set<string>()
  for (const file of files) {
    if (!file.name || /[/\\]/.test(file.name) || file.name.length > 64)
      throw new Error(`invalid ISO file name: ${file.name}`)
    const primary = primaryName(file.name)
    if (names.has(primary)) throw new Error(`ISO name collision: ${file.name}`)
    names.add(primary)
  }

  // Layout: 16 system sectors, PVD, Joliet SVD, terminator, 4 path tables, 2 root dirs, file data.
  const pathTableL = 19
  const pathTableM = 20
  const jolietPathL = 21
  const jolietPathM = 22
  const firstDir = 23

  // Directory sizes do not depend on extents, so they are computed with placeholders first.
  const entries = files.map((file) => ({
    file,
    primary: encoder.encode(primaryName(file.name)),
    joliet: ucs2(file.name),
    extent: 0,
  }))
  const sizeOf = (kind: 'primary' | 'joliet') =>
    directory([
      dirRecord(new Uint8Array([0]), 0, 0, true, date),
      dirRecord(new Uint8Array([1]), 0, 0, true, date),
      ...entries.map((e) => dirRecord(e[kind], 0, 0, false, date)),
    ]).length / SECTOR
  const primarySectors = sizeOf('primary')
  const jolietSectors = sizeOf('joliet')
  const primaryDir = firstDir
  const jolietDir = primaryDir + primarySectors
  let next = jolietDir + jolietSectors
  for (const entry of entries) {
    const sectors = Math.ceil(entry.file.data.length / SECTOR)
    entry.extent = sectors ? next : 0
    next += sectors
  }
  const totalSectors = next

  const buildDir = (kind: 'primary' | 'joliet', self: number, sectors: number) =>
    directory([
      dirRecord(new Uint8Array([0]), self, sectors * SECTOR, true, date),
      dirRecord(new Uint8Array([1]), self, sectors * SECTOR, true, date),
      ...[...entries]
        .sort((a, b) => compareBytes(a[kind], b[kind]))
        .map((e) => dirRecord(e[kind], e.extent, e.file.data.length, false, date)),
    ])

  const iso = new Uint8Array(totalSectors * SECTOR)
  const view = new DataView(iso.buffer)

  const pathTable = (sector: number, dirSector: number, littleEndian: boolean) => {
    const at = sector * SECTOR
    iso[at] = 1
    view.setUint32(at + 2, dirSector, littleEndian)
    view.setUint16(at + 6, 1, littleEndian)
    iso[at + 8] = 0
  }
  pathTable(pathTableL, primaryDir, true)
  pathTable(pathTableM, primaryDir, false)
  pathTable(jolietPathL, jolietDir, true)
  pathTable(jolietPathM, jolietDir, false)

  const descriptor = (sector: number, joliet: boolean) => {
    const at = sector * SECTOR
    iso[at] = joliet ? 2 : 1
    ascii(iso, at + 1, 5, 'CD001')
    iso[at + 6] = 1
    const text = joliet ? ucs2Field : ascii
    text(iso, at + 8, 32, '')
    text(iso, at + 40, 32, options.volumeId)
    both32(view, at + 80, totalSectors)
    if (joliet) iso.set([0x25, 0x2f, 0x45], at + 88) // UCS-2 level 3
    both16(view, at + 120, 1)
    both16(view, at + 124, 1)
    both16(view, at + 128, SECTOR)
    both32(view, at + 132, 10)
    view.setUint32(at + 140, joliet ? jolietPathL : pathTableL, true)
    view.setUint32(at + 148, joliet ? jolietPathM : pathTableM, false)
    const dir = joliet ? jolietDir : primaryDir
    const sectors = joliet ? jolietSectors : primarySectors
    iso.set(dirRecord(new Uint8Array([0]), dir, sectors * SECTOR, true, date), at + 156)
    for (const [offset, length] of [
      [190, 128],
      [318, 128],
      [446, 128],
      [574, 128],
      [702, 37],
      [739, 37],
      [776, 37],
    ] as const) {
      text(iso, at + offset, length, offset === 574 ? 'MILIBOT' : '')
    }
    decDate(iso, at + 813, date)
    decDate(iso, at + 830, date)
    decDate(iso, at + 847, null)
    decDate(iso, at + 864, null)
    iso[at + 881] = 1
  }
  descriptor(16, false)
  descriptor(17, true)
  const term = 18 * SECTOR
  iso[term] = 255
  ascii(iso, term + 1, 5, 'CD001')
  iso[term + 6] = 1

  iso.set(buildDir('primary', primaryDir, primarySectors), primaryDir * SECTOR)
  iso.set(buildDir('joliet', jolietDir, jolietSectors), jolietDir * SECTOR)
  for (const entry of entries) {
    if (entry.file.data.length) iso.set(entry.file.data, entry.extent * SECTOR)
  }
  return iso
}
