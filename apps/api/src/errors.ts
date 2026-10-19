import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Every client visible failure is one of these. The code is stable API surface:
 * clients branch on `code`, never on the message.
 */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function invalidRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, 'invalid_request', message, details);
}
