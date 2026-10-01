import { posix } from 'node:path'

import {
  optionalBoolean,
  optionalInteger,
  optionalString,
  type ToolArgs,
  ToolInputError,
} from '@milibot/agent/tools'
import { IMAGE_ASPECTS, type ImageAspect, MAX_IMAGES_PER_CALL } from '@milibot/shared'

import { type ToolHandlers, ToolSwitch } from '../tools-core'
import type { ImageJob, ImageService } from './service'

const MAX_PROMPT_CHARS = 4000
const MAX_REFERENCES = 4

/** A list of strings (a single string counts as one), trimmed, with its size limits; anything else is refused. */
function stringList(a: ToolArgs, key: string, max: number, maxChars: number): string[] {
  const value = a[key]
  if (value === undefined || value === null) return []
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list) || list.some((v) => typeof v !== 'string'))
    throw new ToolInputError(`"${key}" must be a list of strings`)
  const items = (list as string[]).map((v) => v.trim()).filter(Boolean)
  if (items.length > max) throw new ToolInputError(`"${key}" takes at most ${max} items`)
  const long = items.find((v) => v.length > maxChars)
  if (long) throw new ToolInputError(`each of "${key}" has at most ${maxChars} characters`)
  return items
}

function parseImageJob(a: ToolArgs): ImageJob {
  const prompts = stringList(a, 'prompts', MAX_IMAGES_PER_CALL, MAX_PROMPT_CHARS)
  if (prompts.length === 0) throw new ToolInputError('"prompts" needs at least one prompt')
  const count = optionalInteger(a, 'count', 1, MAX_IMAGES_PER_CALL) ?? 1
  if (prompts.length * count > MAX_IMAGES_PER_CALL)
    throw new ToolInputError(
      `At most ${MAX_IMAGES_PER_CALL} pictures per call (${prompts.length} prompts × ${count}); call again for more`,
    )
  const aspect = optionalString(a, 'aspect') ?? '1:1'
  if (!(IMAGE_ASPECTS as readonly string[]).includes(aspect))
    throw new ToolInputError(`"aspect" must be one of ${IMAGE_ASPECTS.join(', ')}`)
  const references = stringList(a, 'references', MAX_REFERENCES, 1000).map((p) => posix.normalize(p))
  const outside = references.find((p) => !p.startsWith('/workspace/'))
  if (outside) throw new ToolInputError(`references must be files under /workspace (got ${outside})`)
  return {
    prompts,
    count,
    aspect: aspect as ImageAspect,
    transparent: optionalBoolean(a, 'transparent') ?? false,
    references,
    name: optionalString(a, 'name')?.trim() || null,
    model: optionalString(a, 'model')?.trim() || null,
    share: optionalBoolean(a, 'share') ?? true,
  }
}

/** `generate_image`: draws with the workspace's image model and posts the pictures to the chat. */
export class ImageTools extends ToolSwitch {
  readonly name = 'images'
  protected readonly handlers: ToolHandlers = {
    generate_image: (ctx, a) => this.deps.images.generate(ctx, parseImageJob(a)),
  }

  constructor(private readonly deps: { images: ImageService }) {
    super()
  }
}
