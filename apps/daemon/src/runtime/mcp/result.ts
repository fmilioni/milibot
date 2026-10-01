import { type BlobStore, pngSize, type ToolResult } from '@milibot/agent'
import type { ContentPart } from '@milibot/agent/llm'

import { jpegSize } from '../files'

/** Content block of an MCP `tools/call` result (`CallToolResult.content`). */
type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: 'resource_link'; uri: string; name?: string; description?: string; mimeType?: string }
  | { type: string; [key: string]: unknown }

export interface McpCallResult {
  content?: McpContentBlock[]
  structuredContent?: unknown
  isError?: boolean
  /** Result shape of pre-2025 protocol versions. */
  toolResult?: unknown
}

const describeBytes = (base64: string) => `${Math.floor((base64.length * 3) / 4)} bytes`

/**
 * Maps an MCP tool result to Milibot's tool result: text as is, PNG/JPEG images as image inputs
 * (stored in the blob store like screenshots), embedded text resources as text with their URI,
 * binary resources, audio and links as a short text line.
 */
export async function mapMcpResult(result: McpCallResult, blobs: BlobStore): Promise<ToolResult> {
  const parts: ContentPart[] = []
  const blocks = Array.isArray(result.content) ? result.content : []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: String((block as { text?: unknown }).text ?? '') })
        break
      case 'image': {
        const { data, mimeType } = block as { data: string; mimeType: string }
        const bytes = new Uint8Array(Buffer.from(data, 'base64'))
        const size =
          mimeType === 'image/png' ? pngSize(bytes) : mimeType === 'image/jpeg' ? jpegSize(bytes) : null
        if (size && (mimeType === 'image/png' || mimeType === 'image/jpeg')) {
          const sha256 = await blobs.put(bytes, mimeType)
          parts.push({ type: 'image', sha256, mediaType: mimeType, ...size })
        } else {
          parts.push({
            type: 'text',
            text: `[image ${mimeType}, ${describeBytes(data)}: format not supported]`,
          })
        }
        break
      }
      case 'audio': {
        const { data, mimeType } = block as { data: string; mimeType: string }
        parts.push({ type: 'text', text: `[audio ${mimeType}, ${describeBytes(data)}]` })
        break
      }
      case 'resource': {
        const resource = (
          block as { resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
        ).resource
        if (typeof resource.text === 'string') {
          parts.push({ type: 'text', text: `Resource ${resource.uri}:\n${resource.text}` })
        } else {
          parts.push({
            type: 'text',
            text: `[resource ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ''}${resource.blob ? `, ${describeBytes(resource.blob)}` : ''}]`,
          })
        }
        break
      }
      case 'resource_link': {
        const link = block as { uri: string; name?: string; description?: string }
        const label = [link.name, link.description].filter(Boolean).join(' — ')
        parts.push({ type: 'text', text: `Link: ${link.uri}${label ? ` (${label})` : ''}` })
        break
      }
      default:
        parts.push({ type: 'text', text: JSON.stringify(block) })
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push({ type: 'text', text: JSON.stringify(result.structuredContent) })
  }
  if (parts.length === 0 && result.toolResult !== undefined) {
    parts.push({ type: 'text', text: JSON.stringify(result.toolResult) })
  }
  if (parts.length === 0) parts.push({ type: 'text', text: '(no output)' })
  return { content: parts, ...(result.isError ? { isError: true } : {}) }
}
