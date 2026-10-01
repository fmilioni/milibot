import type { MessageAttachment } from '@milibot/shared'

const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g

/** The VM path a markdown image points to (the renderer gets it percent-encoded, e.g. accents). */
export function imageSourcePath(src: string): string {
  const path = src.startsWith('file://') ? src.slice('file://'.length) : src
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

/**
 * Splits a bot message's attachments into the images its markdown places inline (by VM path; the daemon
 * attaches the images a reply mentions) and the rest, shown below the text.
 */
export function splitInlineImages(
  text: string,
  attachments: MessageAttachment[],
): { inline: MessageAttachment[]; rest: MessageAttachment[] } {
  if (attachments.length === 0 || !text.includes('![')) return { inline: [], rest: attachments }
  const sources = new Set<string>()
  for (const match of text.matchAll(MARKDOWN_IMAGE)) sources.add(imageSourcePath(match[1] ?? match[2] ?? ''))
  const inline: MessageAttachment[] = []
  const rest: MessageAttachment[] = []
  for (const attachment of attachments)
    (attachment.image && attachment.status !== 'removed' && sources.has(attachment.path)
      ? inline
      : rest
    ).push(attachment)
  return { inline, rest }
}
