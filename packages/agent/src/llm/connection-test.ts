import { solidPng } from '../media/png'
import { MemoryBlobStore } from './blobs'
import { complete, type ConnectionTestResult, type LLMProvider } from './provider'

/** Minimal call with a tool and a small image; degrades to find which capabilities work. */
export async function testWithToolAndImage(
  provider: LLMProvider,
  model: string,
): Promise<ConnectionTestResult> {
  const blobs = new MemoryBlobStore()
  const sha = blobs.add(solidPng(32, 32, [220, 30, 30]))
  const tool = {
    name: 'report_color',
    description: 'Report the dominant color of the image.',
    inputSchema: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] },
  }
  const ask = (withImage: boolean, withTool: boolean) =>
    complete(provider, {
      model,
      blobs,
      maxOutputTokens: 200,
      tools: withTool ? [tool] : [],
      messages: [
        {
          role: 'user',
          content: [
            ...(withImage
              ? [
                  {
                    type: 'image' as const,
                    sha256: sha,
                    mediaType: 'image/png' as const,
                    width: 32,
                    height: 32,
                  },
                ]
              : []),
            {
              type: 'text',
              text: withTool
                ? 'Call report_color with the dominant color of the image (or "none" if there is no image).'
                : 'Reply with the single word: ok',
            },
          ],
        },
      ],
    })
  try {
    const full = await ask(true, true)
    return {
      ok: true,
      supportsVision: true,
      supportsTools: Boolean(full.message.toolCalls?.length),
      error: null,
    }
  } catch (fullError) {
    try {
      const noImage = await ask(false, true)
      return {
        ok: true,
        supportsVision: false,
        supportsTools: Boolean(noImage.message.toolCalls?.length),
        error: null,
      }
    } catch {
      try {
        await ask(false, false)
        return { ok: true, supportsVision: false, supportsTools: false, error: null }
      } catch (plainError) {
        return {
          ok: false,
          supportsTools: false,
          supportsVision: false,
          error: (plainError as Error).message || (fullError as Error).message,
        }
      }
    }
  }
}
