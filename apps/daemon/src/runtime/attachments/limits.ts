import { ATTACHMENT_SETTING_KEYS, AttachmentSettings, DEFAULT_ATTACHMENT_MAX_FILE_MB } from '@milibot/shared'

import type { SettingsStore } from '../settings'

export const MB = 1024 * 1024
/** Bytes per `/fs/write` into the VM (base64 in JSON; the guest agent takes up to 64 MB per request). */
export const COPY_CHUNK_BYTES = 4 * MB
/** Largest image sent to the models as an image (Anthropic's per-image limit). */
export const MAX_MODEL_IMAGE_BYTES = 5 * MB
export const MAX_MODEL_IMAGE_SIDE = 8000

/** Largest file of the chats (setting, in MB). */
export function maxFileMb(settings: Pick<SettingsStore, 'get'>): number {
  const value = settings.get<number>(ATTACHMENT_SETTING_KEYS.maxFileMb, DEFAULT_ATTACHMENT_MAX_FILE_MB)
  return AttachmentSettings.shape.maxFileMb.safeParse(value).success ? value : DEFAULT_ATTACHMENT_MAX_FILE_MB
}
