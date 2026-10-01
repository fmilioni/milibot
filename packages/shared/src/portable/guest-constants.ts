// Values the guest shell scripts (vm/provision.d, vm/guest) repeat; guest-constants.test.ts keeps them equal.

export const AGENT_USER = 'agent'
export const AGENT_UID = 1500
export const WORKSPACE_GID = 1450
export const DOCKER_GID = 1451

/** Uids the guest agent accepts for bot users (`bot-<slug>`, uid = gid). */
export const MIN_BOT_UID = 1600
export const MAX_BOT_UID = 59999
/** Uid of a workspace's first bot; the next ones count up and are never reused. */
export const FIRST_BOT_UID = 2001

/** A bot slug (the Linux user is `bot-<slug>`): a letter, then letters/digits in hyphen-separated groups. */
export const BOT_SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
export const BOT_SLUG_MAX_LENGTH = 28

export function isBotSlug(value: string): boolean {
  return BOT_SLUG_PATTERN.test(value) && value.length <= BOT_SLUG_MAX_LENGTH
}

/** Debian packages of document extraction (`/extract`), installed by `provision.d`. */
export const EXTRACT_PACKAGES = [
  'poppler-utils',
  'pandoc',
  'tesseract-ocr',
  'tesseract-ocr-por',
  'tesseract-ocr-eng',
] as const

/** Tesseract languages of the OCR packages above. */
export const OCR_LANGUAGES = 'por+eng'
