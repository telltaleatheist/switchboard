/**
 * Loud failure primitives. Every rejected request in Switchboard travels as an
 * HttpError carrying an exact status and a human-readable reason; nothing is
 * ever coerced, defaulted or swallowed (SPEC §2).
 */

export class HttpError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const badRequest = (reason: string): HttpError => new HttpError(400, reason);
export const unauthorized = (reason: string): HttpError => new HttpError(401, reason);
export const forbidden = (reason: string): HttpError => new HttpError(403, reason);
export const notFound = (reason: string): HttpError => new HttpError(404, reason);
export const conflict = (reason: string): HttpError => new HttpError(409, reason);
export const payloadTooLarge = (reason: string): HttpError => new HttpError(413, reason);
