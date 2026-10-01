const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
const SEPARATORS = /[\s,]*/y

interface PathSegment {
  command: string
  args: number[]
}

export interface Point {
  x: number
  y: number
}

interface Scan {
  segments: PathSegment[]
  end: number
}

/** `cut`: `d` may end mid-number, so a number touching its end leaves its segment unfinished. */
function scan(d: string, cut: boolean): Scan {
  const segments: PathSegment[] = []
  let end = 0
  let i = 0
  let command: string | null = null
  const skip = () => {
    SEPARATORS.lastIndex = i
    SEPARATORS.exec(d)
    i = SEPARATORS.lastIndex
  }
  for (;;) {
    skip()
    if (i >= d.length) break
    const ch = d[i] as string
    if (/[a-zA-Z]/.test(ch)) {
      if (!(ch.toLowerCase() in ARITY)) break
      command = ch
      i++
      if (ch.toLowerCase() === 'z') {
        segments.push({ command: ch, args: [] })
        end = i
        command = null
      }
      continue
    }
    if (!command) break
    const arity = ARITY[command.toLowerCase()] as number
    const args: number[] = []
    let complete = true
    for (let k = 0; k < arity; k++) {
      skip()
      const isFlag = command.toLowerCase() === 'a' && (k === 3 || k === 4)
      if (isFlag) {
        const flag = d[i]
        if (flag !== '0' && flag !== '1') {
          complete = false
          break
        }
        args.push(Number(flag))
        i++
        continue
      }
      NUMBER.lastIndex = i
      const m = NUMBER.exec(d)
      if (!m || (cut && NUMBER.lastIndex >= d.length)) {
        complete = false
        break
      }
      args.push(Number(m[0]))
      i = NUMBER.lastIndex
    }
    if (!complete) break
    segments.push({ command, args })
    end = i
    // Coordinates after a moveto are implicit linetos.
    if (command === 'M') command = 'L'
    else if (command === 'm') command = 'l'
  }
  return { segments, end }
}

/** '' until something is drawn after the first moveto. */
export function completePathData(d: string): string {
  const { segments, end } = scan(d, true)
  const draws = segments.some((s, i) => i > 0 && s.command.toLowerCase() !== 'm')
  return draws ? d.slice(0, end).trimEnd() : ''
}

export function pathEnd(d: string): Point | null {
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let moved = false
  for (const { command, args } of scan(d, false).segments) {
    const relative = command === command.toLowerCase()
    const ox = relative ? x : 0
    const oy = relative ? y : 0
    switch (command.toLowerCase()) {
      case 'm':
        x = ox + (args[0] as number)
        y = oy + (args[1] as number)
        startX = x
        startY = y
        moved = true
        break
      case 'h':
        x = ox + (args[0] as number)
        break
      case 'v':
        y = oy + (args[0] as number)
        break
      case 'z':
        x = startX
        y = startY
        break
      default:
        x = ox + (args[args.length - 2] as number)
        y = oy + (args[args.length - 1] as number)
    }
  }
  return moved ? { x, y } : null
}
