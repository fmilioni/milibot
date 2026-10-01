import type { IncomingMessage, ServerResponse } from 'node:http'

import type { GuestErrorBody } from '@milibot/shared/portable/guest-api'

import { badRequest, HttpError } from './errors.ts'

export type Json = Record<string, unknown>

export function send(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length })
  res.end(data)
}

/** The whole request body; past `max` bytes it throws `tooLarge()` (checked on Content-Length first). */
export async function readBody(
  req: IncomingMessage,
  max: number,
  tooLarge = () => new HttpError(413, 'body_too_large', 'request body too large'),
): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > max) throw tooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) throw tooLarge()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** A JSON object body; an empty body is `{}`. */
export async function readJson(req: IncomingMessage, max: number): Promise<Json> {
  const body = await readBody(req, max)
  if (body.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Json
  } catch {
    throw badRequest('body must be a JSON object', 'invalid_json')
  }
}

/** Answers a failed request with `{error: {code, message}}`; a response already streaming is cut. */
export function sendError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  const e =
    err instanceof HttpError
      ? err
      : new HttpError(
          500,
          (err as NodeJS.ErrnoException).code === 'EACCES' ? 'permission_denied' : 'internal',
          (err as Error).message,
        )
  if (e.status >= 500) console.error(`${req.method} ${req.url}: ${e.message}`)
  if (res.headersSent) return void res.end()
  send(res, e.status, { error: { code: e.code, message: e.message } } satisfies GuestErrorBody)
}
