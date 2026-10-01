import { type Bot, CODEX_HOME, type ImageAspect } from '@milibot/shared'

import type { GuestCliBackend } from '../cli/backend'
import { type ImageBytes, ImageGenerationError, type ImageResult } from '../images/types'
import type { ThreadItem, ThreadStartResponse, Turn, UserInput } from './protocol'
import { CodexRpc } from './rpc'
import { answerServerRequest } from './sessions'

/** The image model a Codex provider offers: pictures drawn by the ChatGPT subscription through Codex. */
export const CODEX_IMAGE_MODEL = 'codex-image'

export interface CodexImageRequest {
  bot: Bot
  /** Chat model that runs the drawing turn (a light one: it only calls the image tool). */
  model: string | null
  env: Record<string, string>
  providerConfig: Record<string, unknown>
  prompt: string
  count: number
  aspect: ImageAspect
  transparent: boolean
  /** Reference pictures, as paths in the VM (Codex reads them itself). */
  referencePaths: string[]
  signal?: AbortSignal
}

const ASPECT_WORDS: Record<ImageAspect, string> = {
  '1:1': 'square',
  '16:9': 'wide (16:9)',
  '9:16': 'tall (9:16)',
  '4:3': 'landscape (4:3)',
  '3:4': 'portrait (3:4)',
  '3:2': 'landscape (3:2)',
  '2:3': 'portrait (2:3)',
}

function drawingInstructions(request: CodexImageRequest): string {
  const pictures = request.count === 1 ? 'one picture' : `${request.count} different pictures`
  return [
    `Draw ${pictures} of what the user describes with the image generation tool, one tool call per picture.`,
    `Format: ${ASPECT_WORDS[request.aspect]}.${request.transparent ? ' Transparent background.' : ''}`,
    request.referencePaths.length ? 'Use the attached pictures as references.' : '',
    'Do not use any other tool, and do not write anything after drawing.',
  ]
    .filter(Boolean)
    .join('\n')
}

function decode(result: string): ImageBytes | null {
  const data = result.startsWith('data:') ? result.slice(result.indexOf(',') + 1) : result
  if (!data) return null
  const bytes = new Uint8Array(Buffer.from(data, 'base64'))
  if (bytes.length < 8) return null
  const png = bytes[0] === 0x89 && bytes[1] === 0x50
  return { bytes, mediaType: png ? 'image/png' : 'image/jpeg' }
}

/**
 * Draws with the image tool of a Codex thread (ChatGPT subscription): an ephemeral thread in a process of
 * its own whose only job is calling the tool, the pictures read from its `imageGeneration` items.
 */
export async function codexGenerateImages(
  backend: GuestCliBackend,
  request: CodexImageRequest,
  log: (message: string, extra?: Record<string, unknown>) => void = () => {},
): Promise<ImageResult> {
  const signal = request.signal ?? new AbortController().signal
  const rpc = await CodexRpc.start(
    backend,
    {
      user: 'agent',
      argv: ['codex', 'app-server'],
      cwd: '/workspace',
      env: { ...request.env, CODEX_HOME },
      display: request.bot.displayNum,
      label: `codex-image:${request.bot.slug}`,
      bot: request.bot.slug,
    },
    answerServerRequest,
    log,
  )
  const onAbort = () => void rpc.close()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await rpc.initialize()
    const thread = await rpc.request<ThreadStartResponse>('thread/start', {
      cwd: '/workspace',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      developerInstructions: drawingInstructions(request),
      ...(request.model ? { model: request.model } : {}),
      config: {
        ...request.providerConfig,
        'features.image_generation': true,
        'features.multi_agent': false,
        'features.goals': false,
        'features.shell_tool': false,
        'skills.include_instructions': false,
        web_search: 'disabled',
        model_reasoning_effort: 'low',
      },
    })
    const threadId = thread.thread.id
    const input: UserInput[] = [
      { type: 'text', text: request.prompt, text_elements: [] },
      ...request.referencePaths.map((path) => ({ type: 'localImage' as const, path })),
    ]
    const turn = await rpc.request<{ turn: Turn }>('turn/start', { threadId, input })
    const images: ImageBytes[] = []
    let quota: string | null = null
    for (;;) {
      const item = await rpc.items.next(signal)
      if (item.type === 'exit')
        throw new ImageGenerationError('provider_error', `codex exited: ${item.stderr.trim().slice(-500)}`)
      const m = item.message
      const params = (m.params ?? {}) as { threadId?: string; item?: ThreadItem; turn?: Turn }
      if (params.threadId !== threadId) continue
      if (m.method === 'item/completed' && params.item?.type === 'imageGeneration') {
        const generated = params.item as Extract<ThreadItem, { type: 'imageGeneration' }>
        if (generated.failure?.type === 'usageLimitExceeded') quota = 'The image quota of the plan is used up'
        const image = generated.result ? decode(generated.result) : null
        if (image) images.push(image)
      } else if (m.method === 'turn/completed' && params.turn?.id === turn.turn.id) {
        const done = params.turn
        if (images.length) return { images, costUsd: null }
        if (quota || done.error?.codexErrorInfo === 'usageLimitExceeded')
          throw new ImageGenerationError('quota', quota ?? done.error?.message ?? 'usage limit reached')
        if (done.status === 'failed')
          throw new ImageGenerationError('provider_error', done.error?.message ?? 'the drawing turn failed')
        throw new ImageGenerationError('no_image', 'Codex answered without a picture')
      }
    }
  } catch (err) {
    if (signal.aborted) throw new ImageGenerationError('aborted', 'aborted')
    throw err
  } finally {
    signal.removeEventListener('abort', onAbort)
    await rpc.close()
  }
}
