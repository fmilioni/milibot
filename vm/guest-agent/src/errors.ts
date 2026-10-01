export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message)
export const notFound = (message: string, code = 'not_found') => new HttpError(404, code, message)
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message)
