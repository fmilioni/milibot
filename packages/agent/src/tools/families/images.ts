import { IMAGE_ASPECTS, MAX_IMAGES_PER_CALL } from '@milibot/shared'

import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

/**
 * Pictures from the workspace's image model. A setting family: offered only while an image model is
 * registered, so its guidance lives here rather than in a skill.
 */
const definitions = {
  generate_image: {
    name: 'generate_image',
    description:
      'Generate pictures (photos, illustrations, posters, backgrounds, textures, product shots, concept art) ' +
      'with the image model. Files land in /workspace/images and, unless share is false, the user sees them ' +
      'in the chat as they arrive: do not repeat their paths in your reply. You get them back to check.\n' +
      "Never pass the user's words as they are: write the prompt an art director would, in English, with " +
      'the subject and what it does, the setting, composition and framing (close-up, wide, top view), ' +
      'lighting and mood, style or medium (photo with lens and film look, 3D render, watercolor, flat ' +
      'vector), the palette, and what to leave out. Words that must appear in the picture go in double ' +
      "quotes, in the user's language. Keep what the user fixed (brand colors, a character, a layout) in " +
      'every prompt.\n' +
      'Variations: the same prompt with count gives takes on one idea; different directions (styles, ' +
      `concepts) are one prompt each. At most ${MAX_IMAGES_PER_CALL} pictures per call (prompts × count): ` +
      'generate every picture you need in one call instead of one call per picture. Icons are not pictures ' +
      '(use an icon set); logos and marks meant to scale are vector art.',
    inputSchema: {
      type: 'object',
      properties: {
        prompts: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_IMAGES_PER_CALL },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_IMAGES_PER_CALL,
          description: 'Pictures per prompt. Default 1.',
        },
        aspect: {
          type: 'string',
          enum: [...IMAGE_ASPECTS],
          description: 'Width:height; match where the picture goes. Default 1:1.',
        },
        transparent: { type: 'boolean', description: 'Transparent background (cut-outs, stickers).' },
        references: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 4,
          description:
            'Images under /workspace to edit, restyle or keep consistent with (a photo the user sent).',
        },
        name: { type: 'string', description: 'Short file name, without extension.' },
        model: { type: 'string', description: 'Only when the user asked for a specific image model.' },
        share: {
          type: 'boolean',
          description: 'Show them in the chat. Default true; false for design assets.',
        },
      },
      required: ['prompts'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const imageTools = defineTools({
  definitions,
  describe(name, a, view) {
    const prompts = Array.isArray(a.prompts) ? a.prompts.map(scalarText) : []
    const count = prompts.length * (typeof a.count === 'number' && a.count > 1 ? a.count : 1)
    return { kind: name, detail: `${view.clip(prompts[0] ?? '', 60)}${count > 1 ? ` ×${count}` : ''}` }
  },
  labels: { generate_image: 'generated image' },
})
