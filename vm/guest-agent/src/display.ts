import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'

import { botForDisplay } from './bots.ts'
import { HttpError } from './errors.ts'
import type { Json } from './http.ts'
import { actionToSteps, type InputStep } from './input.ts'

const execFileAsync = promisify(execFile)

function displayEnv(display: number): Record<string, string> {
  const bot = botForDisplay(display)
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    DISPLAY: `:${display}`,
    XAUTHORITY: `${bot.home}/.Xauthority`,
    HOME: '/root',
    LANG: 'C.UTF-8',
  }
}

function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR')
    return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

async function screenshot(display: number): Promise<Buffer> {
  const env = displayEnv(display)
  try {
    const { stdout } = await execFileAsync('import', ['-silent', '-window', 'root', 'png:-'], {
      env,
      encoding: 'buffer',
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch (err) {
    throw new HttpError(500, 'screenshot_failed', (err as Error).message)
  }
}

/** `POST /display/:n/screenshot`: PNG bytes for `accept: image/png` (or `encoding: binary`), else base64 JSON. */
export async function handleScreenshot(
  req: IncomingMessage,
  res: ServerResponse,
  display: number,
  body: Json,
) {
  const png = await screenshot(display)
  const size = pngSize(png)
  if (body.encoding === 'binary' || req.headers.accept === 'image/png') {
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': png.length,
      'x-width': String(size?.width ?? ''),
      'x-height': String(size?.height ?? ''),
    })
    res.end(png)
    return undefined
  }
  return { mimeType: 'image/png', width: size?.width, height: size?.height, data: png.toString('base64') }
}

/** `POST /display/:n/input {actions}` */
export async function handleInput(display: number, body: Json): Promise<{ ok: true; steps: number }> {
  const steps = planInput(body.actions)
  await runInput(display, steps)
  return { ok: true, steps: steps.length }
}

function planInput(actions: unknown): InputStep[] {
  const list = Array.isArray(actions) ? actions : [actions]
  if (list.length === 0) throw new HttpError(400, 'invalid_action', 'no actions')
  if (list.length > 200) throw new HttpError(400, 'invalid_action', 'too many actions')
  return list.flatMap((a) => actionToSteps(a))
}

function xdotool(args: string[], env: Record<string, string>, stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('xdotool', args, { env, timeout: 120_000 }, (err) =>
      err ? reject(err) : resolve(),
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(stdin ?? '')
  })
}

async function runInput(display: number, steps: InputStep[]): Promise<void> {
  const env = displayEnv(display)
  for (const step of steps) {
    if ('sleepMs' in step) {
      await new Promise((r) => setTimeout(r, step.sleepMs))
      continue
    }
    try {
      await xdotool(step.xdotool, env, step.stdin)
    } catch (err) {
      throw new HttpError(500, 'input_failed', (err as Error).message)
    }
  }
}
