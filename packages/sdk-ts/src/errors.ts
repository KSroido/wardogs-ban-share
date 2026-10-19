export interface BanListErrorOptions {
  /** HTTP status, or 0 for network/timeout failures. */
  status: number;
  /** Machine readable code from the error envelope, e.g. `duplicate_ban`. */
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class BanListError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(options: BanListErrorOptions) {
    super(options.message);
    this.name = 'BanListError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Worth retrying with the same payload (server side hiccup or throttling). */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      message: this.message,
      details: this.details,
      request_id: this.requestId,
    };
  }
}
