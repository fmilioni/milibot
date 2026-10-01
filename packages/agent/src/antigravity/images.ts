import type { Bot, ImageAspect } from '@milibot/shared'

import type { GuestCliBackend } from '../cli/backend'
import { exitMessage, GuestProcess } from '../cli/guest-process'
import { oneShotProcLabel } from '../cli/lane'
import { type ImageBytes, ImageGenerationError, type ImageResult } from '../images/types'
import { ANTIGRAVITY_PROC_LABEL, antigravityErrorCode } from './config'
import { ANTIGRAVITY_AGENTS_DIR, antigravityAgentFile } from './profile'
import { antigravityEffort } from './sessions'
import { antigravityInputLine, parseAntigravityLine } from './stream-json'

/** The image model an Antigravity provider offers: pictures drawn by the Google AI plan through `agy`. */
export const ANTIGRAVITY_IMAGE_MODEL = 'antigravity-image'

export interface AntigravityImageRequest {
  bot: Bot
  /** Chat model that runs the drawing turn (a light one: it only calls the image tool). */
  model: string | null
  env: Record<string, string>
  prompt: string
  count: number
  aspect: ImageAspect
  transparent: boolean
  /** Reference pictures, as paths in the VM (`agy` reads them itself). */
  referencePaths: string[]
  signal?: AbortSignal
  /**
   * The pictures `generate_image` saved in the conversation's folder, by the `ImageName`s it was called with
   * (`agy` reports no path: it saves `<ImageName>_<timestamp>.<ext>`).
   */
  readImages(conversationId: string, names: string[]): Promise<ImageBytes[]>
}

function drawingInstructions(request: AntigravityImageRequest): string {
  const pictures = request.count === 1 ? 'one picture' : `${request.count} different pictures`
  return [
    '# Drawing',
    '',
    `Draw ${pictures} of what the user describes with the generate_image tool, one call per picture, each with its own ImageName.`,
    `Pass AspectRatio "${request.aspect}".${request.transparent ? ' Ask for a transparent background.' : ''}`,
    request.referencePaths.length
      ? `Pass these reference pictures in ImagePaths: ${request.referencePaths.join(', ')}.`
      : '',
    'Do not use any other tool, and do not write anything after drawing.',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Draws with `agy`'s `generate_image` (the Google AI plan): a one-off process whose agent only has that tool,
 * the pictures read from the conversation's folder once it finished.
 */
export async function antigravityGenerateImages(
  backend: GuestCliBackend,
  request: AntigravityImageRequest,
  log: (message: string, extra?: Record<string, unknown>) => void = () => {},
): Promise<ImageResult> {
  const signal = request.signal ?? new AbortController().signal
  const agent = `milibot-${request.bot.slug}-draw-image`
  // The drawing turn only calls the image tool: the lowest level the model takes.
  const effort = antigravityEffort(request.model, 'low')
  await backend.writeAgentFile(
    `${ANTIGRAVITY_AGENTS_DIR}/${agent}/agent.md`,
    antigravityAgentFile(agent, ['generate_image'], drawingInstructions(request), { lane: false }),
  )
  const proc = await GuestProcess.start(
    backend,
    {
      user: 'agent',
      argv: [
        'agy',
        '--agent',
        agent,
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
        ...(request.model ? ['--model', request.model] : []),
        ...(effort ? ['--effort', effort] : []),
        '-p=',
      ],
      cwd: '/workspace',
      env: request.env,
      display: request.bot.displayNum,
      label: oneShotProcLabel(ANTIGRAVITY_PROC_LABEL, request.bot, 'image'),
      bot: request.bot.slug,
    },
    { log },
  )
  let conversationId: string | null = null
  const names: string[] = []
  const finished = new Promise<{ ok: boolean; error: string | null }>((resolve, reject) => {
    let result: { ok: boolean; error: string | null } | null = null
    const onAbort = () => {
      void proc.close()
      reject(new ImageGenerationError('aborted', 'aborted'))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    proc.listen({
      line: (line) => {
        const event = parseAntigravityLine(line)
        if (event?.type === 'init') conversationId = event.conversationId
        else if (event?.type === 'result') result = { ok: event.ok, error: event.error || null }
        else if (event?.type === 'step' && event.tool?.name === 'generate_image' && event.state === 'DONE') {
          const name = event.tool.parameters.ImageName
          if (typeof name === 'string' && name && !names.includes(name)) names.push(name)
        }
      },
      exit: (exit) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result ?? { ok: false, error: exitMessage('agy', exit) })
      },
    })
  })
  await proc.write(antigravityInputLine(request.prompt), true)
  const outcome = await finished
  const images = conversationId && names.length ? await request.readImages(conversationId, names) : []
  if (images.length) return { images, costUsd: null }
  if (outcome.error && antigravityErrorCode(outcome.error) === 'cli_usage_limit')
    throw new ImageGenerationError('quota', outcome.error)
  if (!outcome.ok)
    throw new ImageGenerationError('provider_error', outcome.error ?? 'the drawing turn failed')
  throw new ImageGenerationError('no_image', 'Antigravity answered without a picture')
}
