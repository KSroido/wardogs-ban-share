import type { Context } from 'hono';
import type { AppEnv } from './env';
import { ApiError } from './errors';

const MAX_BODY_BYTES = 1_000_000;

export async function readJson(c: Context<AppEnv>): Promise<unknown> {
  const length = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'Request body must be under 1 MB.');
  }

  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

/** For endpoints where an empty body is valid (e.g. revoke without a reason). */
export async function readOptionalJson(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}
