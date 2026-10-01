import { posix } from 'node:path'

import {
  type BlobStore,
  type LlmCallRecord,
  type NewAgentMessage,
  pngSize,
  type ToolExecContext,
  type ToolResult,
} from '@milibot/agent'
import {
  checkImageRequest,
  generateImages,
  type ImageBytes,
  type ImageGenerate,
  ImageGenerationError,
  type ImageResult,
} from '@milibot/agent/images'
import type { ContentPart } from '@milibot/agent/llm'
import { toolError, ToolInputError } from '@milibot/agent/tools'
import {
  type Bot,
  type CliEngine,
  type GeneratedImagesPayload,
  type ImageAspect,
  type ImageModelChoice,
  isCliEngine,
  type LogFn,
  type Message,
  type MessagePayload,
  type ProviderModel,
  type ProviderType,
  slugify,
} from '@milibot/shared'

import { errorMessage } from '../../errors'
import { localDay } from '../../util/time'
import { imageMediaType, jpegSize } from '../files'
import type { CliImageJob, ProviderStore } from '../providers'
import { botLinuxUser, type GuestClient, GuestError, type VmController } from '../vm'

const IMAGES_ROOT = '/workspace/images'
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
/** What the models accept as an image input (Anthropic's limits). */
const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_MODEL_IMAGE_SIDE = 8000
const REFERENCE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface ImageServiceDeps {
  providers: Pick<ProviderStore, 'imageModel' | 'imageModels' | 'server'>
  /** Draws with a CLI engine provider's subscription, through the engine in the VM (absent without it). */
  cliImages?: (bot: Bot, providerId: string, engine: CliEngine, job: CliImageJob) => Promise<ImageResult>
  preference: () => ImageModelChoice | null
  vm: Pick<VmController, 'status' | 'runningGuest'>
  blobs: Pick<BlobStore, 'put'>
  cardConversation: (bot: Bot, conversationId: string | null) => string
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  recordLlmCall: (record: LlmCallRecord) => string
  /** Replaces the providers (`MILIBOT_FAKE_IMAGES`, tests). */
  generate?: ImageGenerate
  now: () => number
  log: LogFn
}

export interface ImageJob {
  prompts: string[]
  count: number
  aspect: ImageAspect
  transparent: boolean
  references: string[]
  name: string | null
  model: string | null
  share: boolean
}

interface SavedImage {
  promptIndex: number
  path: string
  mediaType: string
  sha: string | null
  width: number | null
  height: number | null
}

type Slot = GeneratedImagesPayload['images'][number]
type ImageFailure = NonNullable<Slot['failure']>

function failureOf(err: unknown): ImageFailure {
  if (!(err instanceof ImageGenerationError)) return 'error'
  if (err.code === 'quota' || err.code === 'rate_limited') return err.code
  if (err.code === 'no_image') return 'blocked'
  return 'error'
}

interface Card {
  messageId: string
  payload: GeneratedImagesPayload
}

function imageSize(bytes: Uint8Array, mediaType: string): { width: number; height: number } | null {
  if (mediaType === 'image/png') return pngSize(bytes)
  if (mediaType === 'image/jpeg') return jpegSize(bytes)
  return null
}

function cardContent(paths: string[], total: number): string {
  if (paths.length === 0) return `Generating ${total} image${total === 1 ? '' : 's'}…`
  return `Generated images:\n${paths.map((p) => `- ${p}`).join('\n')}`
}

export class ImageService {
  constructor(private readonly deps: ImageServiceDeps) {}

  /** Whether any image model is registered and enabled (gates the `image_generation` family). */
  available(): boolean {
    return this.deps.providers.imageModels().length > 0
  }

  async generate(ctx: ToolExecContext, job: ImageJob): Promise<ToolResult> {
    const chosen = this.deps.providers.imageModel(this.deps.preference(), job.model ?? undefined)
    if (!chosen) {
      const names = this.deps.providers.imageModels().map((m) => m.model.modelId)
      return toolError(
        job.model && names.length > 0
          ? `No image model "${job.model}". Available: ${names.join(', ')}`
          : 'No image model is set up (Settings → Providers).',
      )
    }
    const { model, providerName, providerType } = chosen
    let draw: (prompt: string, references: ImageBytes[]) => Promise<ImageResult>
    if (isCliEngine(providerType)) {
      const cliImages = this.deps.cliImages
      if (!cliImages) return toolError(`${providerName} needs the workspace VM, which is not available.`)
      draw = (prompt) =>
        cliImages(ctx.bot, model.providerId, providerType, {
          prompt,
          count: job.count,
          aspect: job.aspect,
          transparent: job.transparent,
          referencePaths: job.references,
          signal: ctx.signal,
        })
    } else {
      const server = await this.deps.providers.server(model.providerId)
      try {
        checkImageRequest(server, {
          model: model.modelId,
          transparent: job.transparent,
          referenceCount: job.references.length,
        })
      } catch (err) {
        if (err instanceof ImageGenerationError) return toolError(err.message)
        throw err
      }
      const generate = this.deps.generate ?? generateImages
      draw = (prompt, references) =>
        generate(server, {
          model: model.modelId,
          prompt,
          count: job.count,
          aspect: job.aspect,
          transparent: job.transparent,
          references,
          signal: ctx.signal,
        })
    }
    if (this.deps.vm.status().state !== 'running') return toolError('The VM is not running.')
    const guest = this.deps.vm.runningGuest()
    const references = await this.readReferences(guest, job.references)

    const slots: Slot[] = job.prompts.flatMap((_, promptIndex) =>
      Array.from({ length: job.count }, () => ({
        promptIndex,
        status: 'generating' as const,
        sha: null,
        path: null,
        width: null,
        height: null,
      })),
    )
    const card = job.share ? this.postCard(ctx, model, job.prompts, slots) : null
    const dir = posix.join(IMAGES_ROOT, localDay(this.deps.now()))
    const stem = slugify(job.name ?? job.prompts[0] ?? 'image', { maxLength: 40 }) || 'image'
    const saved: SavedImage[] = []
    const failures: string[] = []
    const reasons = new Set<ImageFailure>()
    let costUsd: number | null = 0

    await Promise.all(
      job.prompts.map(async (prompt, promptIndex) => {
        const started = this.deps.now()
        let result: ImageResult | null = null
        let error: string | null = null
        let failure: ImageFailure = 'error'
        try {
          result = await draw(prompt, references)
        } catch (err) {
          if (ctx.signal.aborted) throw err
          error = errorMessage(err)
          failure = failureOf(err)
          reasons.add(failure)
        }
        const images = result?.images.slice(0, job.count) ?? []
        const cost = this.cost(model, result, images.length)
        costUsd = costUsd === null || cost.usd === null ? null : costUsd + cost.usd
        this.recordCall(ctx, model, providerType, prompt, job, {
          ...cost,
          error,
          latencyMs: this.deps.now() - started,
        })
        if (error) failures.push(`prompt ${promptIndex + 1}: ${error}`)

        const mine = slots.filter((s) => s.promptIndex === promptIndex)
        for (const [i, slot] of mine.entries()) {
          const image = images[i]
          if (!image) {
            Object.assign(slot, { status: 'failed', failure })
            continue
          }
          try {
            const file = await this.save(ctx, guest, dir, stem, image, promptIndex)
            saved.push(file)
            Object.assign(slot, {
              status: 'ready',
              sha: file.sha,
              path: file.path,
              width: file.width,
              height: file.height,
            })
          } catch (err) {
            if (ctx.signal.aborted) throw err
            Object.assign(slot, { status: 'failed', failure: 'error' })
            failures.push(`prompt ${promptIndex + 1}: could not save the picture: ${errorMessage(err)}`)
          }
        }
        if (card) this.updateCard(card, slots, null)
      }),
    ).catch((err: unknown) => {
      if (card) {
        for (const slot of slots) if (slot.status === 'generating') slot.status = 'failed'
        this.updateCard(card, slots, null)
      }
      throw err
    })
    if (card) this.updateCard(card, slots, costUsd)
    return this.result(model, providerName, job, saved, failures, this.advice(model, reasons), card !== null)
  }

  private advice(model: ProviderModel, reasons: Set<ImageFailure>): string[] {
    const others = this.deps.providers
      .imageModels()
      .filter((m) => m.model.providerId !== model.providerId)
      .map((m) => m.model.modelId)
    const alternative =
      others.length > 0 ? ` or call again with model set to one of: ${others.join(', ')}` : ''
    const lines: string[] = []
    if (reasons.has('quota'))
      lines.push(
        `The account of this provider has no quota or credit for ${model.modelId} (a free tier that doesn't ` +
          'include image models, billing off or credit used up). Waiting or retrying will not help: tell the ' +
          `user it needs billing or credit on that account${alternative}.`,
      )
    if (reasons.has('rate_limited'))
      lines.push(
        `The provider kept rate limiting after about 30 s of retries. Don't wait and retry yourself: tell the user${alternative}.`,
      )
    if (reasons.has('blocked'))
      lines.push('The model refused or answered without a picture: rewrite the prompt before trying again.')
    return lines
  }

  private async readReferences(guest: GuestClient, paths: string[]): Promise<ImageBytes[]> {
    return Promise.all(
      paths.map(async (path) => {
        let bytes: Buffer
        try {
          bytes = await guest.fsReadAll(path, {
            maxBytes: MAX_REFERENCE_BYTES,
            tooLarge: (size) =>
              new ToolInputError(
                `${path} has ${Math.round(size / 1024 / 1024)} MB; references take up to 10 MB`,
              ),
          })
        } catch (err) {
          if (err instanceof GuestError && err.code === 'path_not_found')
            throw new ToolInputError(`${path} does not exist`)
          throw err
        }
        const mediaType = imageMediaType(bytes)
        if (!mediaType || !REFERENCE_TYPES.has(mediaType))
          throw new ToolInputError(`${path} is not a PNG, JPEG or WebP image`)
        return { bytes: new Uint8Array(bytes), mediaType }
      }),
    )
  }

  private async save(
    ctx: ToolExecContext,
    guest: GuestClient,
    dir: string,
    stem: string,
    image: ImageBytes,
    promptIndex: number,
  ): Promise<SavedImage> {
    const mediaType = imageMediaType(image.bytes) ?? image.mediaType
    const path = await this.freePath(guest, dir, stem, EXTENSIONS[mediaType] ?? 'png')
    await guest.fsWriteAll(path, image.bytes, { owner: botLinuxUser(ctx.bot.slug) })
    const size = imageSize(image.bytes, mediaType)
    const modelReadable =
      size !== null &&
      image.bytes.length <= MAX_MODEL_IMAGE_BYTES &&
      size.width <= MAX_MODEL_IMAGE_SIDE &&
      size.height <= MAX_MODEL_IMAGE_SIDE
    const sha = modelReadable ? await this.deps.blobs.put(image.bytes, mediaType as 'image/png') : null
    return { promptIndex, path, mediaType, sha, width: size?.width ?? null, height: size?.height ?? null }
  }

  /** `<stem>-1.png`, `<stem>-2.png`… the first one not in the VM yet (parallel saves reserve theirs). */
  private readonly reserved = new Set<string>()
  private async freePath(guest: GuestClient, dir: string, stem: string, ext: string): Promise<string> {
    for (let n = 1; ; n++) {
      const path = posix.join(dir, `${stem}-${n}.${ext}`)
      if (this.reserved.has(path)) continue
      this.reserved.add(path)
      try {
        await guest.fsRead(path, { maxBytes: 1 })
      } catch (err) {
        if (err instanceof GuestError && err.code === 'path_not_found') {
          setTimeout(() => this.reserved.delete(path), 60_000).unref?.()
          return path
        }
        this.reserved.delete(path)
        throw err
      }
      this.reserved.delete(path)
    }
  }

  private cost(
    model: ProviderModel,
    result: ImageResult | null,
    pictures: number,
  ): { usd: number | null; source: 'provider' | 'computed' | 'unknown' } {
    if (result && result.costUsd !== null) return { usd: result.costUsd, source: 'provider' }
    if (pictures === 0) return { usd: 0, source: 'computed' }
    return model.pricePerRequestUsd === null
      ? { usd: null, source: 'unknown' }
      : { usd: model.pricePerRequestUsd * pictures, source: 'computed' }
  }

  private recordCall(
    ctx: ToolExecContext,
    model: ProviderModel,
    providerType: ProviderType,
    prompt: string,
    job: ImageJob,
    outcome: {
      usd: number | null
      source: 'provider' | 'computed' | 'unknown'
      error: string | null
      latencyMs: number
    },
  ): void {
    this.deps.recordLlmCall({
      botId: ctx.bot.id,
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      purpose: 'image_generation',
      providerId: model.providerId,
      providerType,
      model: model.modelId,
      request: {
        prompt,
        count: job.count,
        aspect: job.aspect,
        transparent: job.transparent,
        references: job.references,
      },
      response: null,
      usage: {
        inputTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costUsd: outcome.usd,
        costSource: outcome.source,
      },
      contextComposition: null,
      stopReason: null,
      generationId: null,
      latencyMs: outcome.latencyMs,
      error: outcome.error,
    })
  }

  private postCard(ctx: ToolExecContext, model: ProviderModel, prompts: string[], slots: Slot[]): Card {
    const payload: GeneratedImagesPayload = {
      type: 'generated_images',
      botId: ctx.bot.id,
      model: model.displayName,
      prompts,
      images: slots.map((s) => ({ ...s })),
      costUsd: null,
    }
    const message = this.deps.appendMessage({
      conversationId: this.deps.cardConversation(ctx.bot, ctx.conversationId),
      authorType: 'bot',
      authorBotId: ctx.bot.id,
      kind: 'card',
      content: cardContent([], slots.length),
      payload,
      turnId: ctx.turnId,
    })
    return { messageId: message.id, payload }
  }

  private updateCard(card: Card, slots: Slot[], costUsd: number | null): void {
    const done = !slots.some((s) => s.status === 'generating')
    const paths = done ? slots.flatMap((s) => (s.path ? [s.path] : [])) : []
    try {
      this.deps.updateMessage(card.messageId, {
        content: cardContent(paths, slots.length),
        payload: { ...card.payload, images: slots.map((s) => ({ ...s })), costUsd },
      })
    } catch (err) {
      this.deps.log('warn', 'generated images card update failed', { err: errorMessage(err) })
    }
  }

  private result(
    model: ProviderModel,
    providerName: string,
    job: ImageJob,
    saved: SavedImage[],
    failures: string[],
    advice: string[],
    shown: boolean,
  ): ToolResult {
    const total = job.prompts.length * job.count
    if (saved.length === 0)
      return toolError([`No picture was generated with ${model.modelId}.`, ...failures, ...advice].join('\n'))
    const ordered = [...saved].sort((a, b) => a.promptIndex - b.promptIndex || a.path.localeCompare(b.path))
    const lines = [
      `Generated ${saved.length} of ${total} picture${total === 1 ? '' : 's'} with ${model.displayName} (${providerName})` +
        (shown ? ', shown to the user in the chat:' : ':'),
      ...ordered.map(
        (s) =>
          `- ${s.path}${s.width && s.height ? ` (${s.width}×${s.height})` : ''}` +
          (job.prompts.length > 1 ? ` · prompt ${s.promptIndex + 1}` : ''),
      ),
      ...(failures.length > 0 ? ['Failed:', ...failures.map((f) => `- ${f}`)] : []),
      ...advice,
    ]
    const content: ContentPart[] = [{ type: 'text', text: lines.join('\n') }]
    for (const s of ordered)
      if (s.sha && s.width && s.height)
        content.push({
          type: 'image',
          sha256: s.sha,
          mediaType: s.mediaType as 'image/png' | 'image/jpeg',
          width: s.width,
          height: s.height,
          placeholder: `[generated image ${s.path} removed from the context]`,
        })
    return { content, activity: { detail: '', result: lines.join('\n') } }
  }
}
