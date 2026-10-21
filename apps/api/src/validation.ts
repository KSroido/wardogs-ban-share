import { BAN_REASONS } from '@wardogs/banlist';
import type { BanReason, ListStatus, PlayerSort } from '@wardogs/banlist';
import { base64url } from './crypto';
import { ApiError } from './errors';

export const STEAM_ID_PATTERN = /^7656119\d{10}$/;
export const SERVER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const STATUSES: readonly ListStatus[] = ['active', 'expired', 'revoked', 'all'];
const MAX_BATCH = 100;

export interface ValidatedBan {
  steam_id: string;
  reason: BanReason;
  note: string | null;
  evidence_url: string | null;
  player_name: string | null;
  permanent: boolean;
  duration_days: number | null;
  expires_at: string | null;
  external_case_id: string | null;
}

export type ValidationResult =
  | { ok: true; value: ValidatedBan }
  | { ok: false; code: string; message: string };

class FieldError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Validate one submitted ban. Never throws for user input, so bulk posts can be partial. */
export function validateSubmitBan(raw: unknown, nowIso: string): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'invalid_request', message: 'Each ban must be a JSON object.' };
  }

  const input = raw as Record<string, unknown>;

  try {
    const steamId = readSteamId(input.steam_id);
    const reason = readReason(input.reason);

    if (typeof input.permanent !== 'boolean') {
      throw new FieldError('invalid_request', 'permanent must be true or false.');
    }
    const permanent = input.permanent;

    let durationDays: number | null = null;
    let expiresAt: string | null = null;

    if (permanent) {
      if (input.duration_days !== undefined && input.duration_days !== null) {
        throw new FieldError('invalid_duration', 'duration_days must be omitted when permanent is true.');
      }
    } else {
      const rawDays = input.duration_days;
      if (typeof rawDays !== 'number' || !Number.isInteger(rawDays)) {
        throw new FieldError('invalid_duration', 'duration_days must be an integer when permanent is false.');
      }
      if (rawDays < 1 || rawDays > 36_500) {
        throw new FieldError('invalid_duration', 'duration_days must be between 1 and 36500.');
      }
      durationDays = rawDays;
      expiresAt = new Date(Date.parse(nowIso) + rawDays * 86_400_000).toISOString();
    }

    const note = readOptionalString(input.note, 'note', 1000);
    const playerName = readOptionalString(input.player_name, 'player_name', 64);
    const evidenceUrl = readOptionalString(input.evidence_url, 'evidence_url', 512);
    const externalCaseId = readOptionalString(input.external_case_id, 'external_case_id', 128);

    if (reason === 'ownreason' && !note) {
      throw new FieldError('invalid_request', 'note is required when reason is "ownreason".');
    }

    if (evidenceUrl) {
      let parsed: URL;
      try {
        parsed = new URL(evidenceUrl);
      } catch {
        throw new FieldError('invalid_evidence_url', 'evidence_url must be an absolute URL.');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new FieldError('invalid_evidence_url', 'evidence_url must use http or https.');
      }
    }

    if (externalCaseId && !/^[A-Za-z0-9._:-]+$/.test(externalCaseId)) {
      throw new FieldError(
        'invalid_external_case_id',
        'external_case_id may only contain letters, digits, dot, underscore, colon and dash.',
      );
    }

    return {
      ok: true,
      value: {
        steam_id: steamId,
        reason,
        note,
        evidence_url: evidenceUrl,
        player_name: playerName,
        permanent,
        duration_days: durationDays,
        expires_at: expiresAt,
        external_case_id: externalCaseId,
      },
    };
  } catch (error) {
    if (error instanceof FieldError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

export interface ListQuery {
  status: ListStatus;
  since: string | null;
  cursor: string | null;
  limit: number;
  reasons: BanReason[] | null;
  steamIds: string[] | null;
  servers: string[] | null;
  permanent: boolean | null;
}

export function parseListQuery(params: URLSearchParams): ListQuery {
  const since = params.get('since');

  return {
    status: parseStatus(params.get('status'), 'active'),
    since: since ? parseIso(since, 'since') : null,
    cursor: params.get('cursor') || null,
    limit: parseLimit(params.get('limit'), 100, 500),
    reasons: parseReasons(params.get('reason')),
    steamIds: parseSteamIds(params.get('steam_id')),
    servers: parseServers(params.get('server')),
    permanent: parseOptionalBool(params.get('permanent'), 'permanent'),
  };
}

export function parseStatus(value: string | null, fallback: ListStatus = 'active'): ListStatus {
  if (!value) return fallback;
  if (!(STATUSES as readonly string[]).includes(value)) {
    throw new ApiError(400, 'invalid_request', `status must be one of: ${STATUSES.join(', ')}.`);
  }
  return value as ListStatus;
}

export function parseLimit(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError(400, 'invalid_request', 'limit must be a positive integer.');
  }
  return Math.min(parsed, max);
}

export function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new ApiError(400, 'invalid_request', 'offset must be an integer between 0 and 10000.');
  }
  return parsed;
}

export function parsePlayerSort(value: string | null): PlayerSort {
  const allowed: readonly PlayerSort[] = ['servers', 'active_servers', 'bans', 'active_bans', 'last_reported_at'];
  if (!value) return 'servers';
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ApiError(400, 'invalid_request', `sort must be one of: ${allowed.join(', ')}.`);
  }
  return value as PlayerSort;
}

export function parseSteamId(value: string, field = 'steam_id'): string {
  const trimmed = value.trim();
  if (!STEAM_ID_PATTERN.test(trimmed)) {
    throw new ApiError(400, 'invalid_steam_id', `${field} must be a 17-digit SteamID64 starting with 7656119.`);
  }
  return trimmed;
}

export function parseServerId(value: string, field = 'server'): string {
  const trimmed = value.trim();
  if (!SERVER_ID_PATTERN.test(trimmed)) {
    throw new ApiError(400, 'invalid_server_id', `${field} must be a lowercase slug (a-z, 0-9, dash).`);
  }
  return trimmed;
}

/**
 * 管理方（owner）：一组服的运营方标识。归一化成小写 slug，方便「同管理方」判断。
 * 允许字母数字、短横线、下划线、点，2–32 位。
 */
export function parseOwner(value: unknown, field = 'owner'): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', `${field} must be a string.`);
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(normalized)) {
    throw new ApiError(
      400,
      'invalid_owner',
      `${field} must be 2-32 chars: letters, digits, dot, dash or underscore.`,
    );
  }
  return normalized;
}

/**
 * 地理位置（location）：申请接入时必填，例如 `CN`、`EU-Frankfurt`、`US-West`。
 * 归一化成小写并把空格换成短横线 —— 「同管理方 + 同位置」要能精确匹配，大小写不能分裂。
 */
export function parseLocation(value: unknown, field = 'location'): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', `${field} must be a string.`);
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(normalized)) {
    throw new ApiError(
      400,
      'invalid_location',
      `${field} must be 2-32 chars (e.g. cn, eu-frankfurt, us-west).`,
    );
  }
  return normalized;
}

/** Build the `status` filter fragment. Returns null for `all`. */
export function statusClause(status: ListStatus, nowIso: string): { sql: string; params: string[] } | null {
  switch (status) {
    case 'active':
      return { sql: "b.status = 'active' AND (b.expires_at IS NULL OR b.expires_at > ?)", params: [nowIso] };
    case 'expired':
      return { sql: "b.status = 'active' AND b.expires_at IS NOT NULL AND b.expires_at <= ?", params: [nowIso] };
    case 'revoked':
      return { sql: "b.status = 'revoked'", params: [] };
    default:
      return null;
  }
}

export function encodeCursor(updatedAt: string, id: string): string {
  return base64url(new TextEncoder().encode(`${updatedAt}|${id}`));
}

export function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const normalized = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const text = atob(padded);
    const separator = text.lastIndexOf('|');
    if (separator <= 0 || separator === text.length - 1) throw new Error('malformed');

    const updatedAt = text.slice(0, separator);
    if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('malformed');

    return { updatedAt, id: text.slice(separator + 1) };
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'cursor is not a valid pagination cursor.');
  }
}

export function maxSubmitBatch(): number {
  return MAX_BATCH;
}

function readSteamId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new FieldError('invalid_steam_id', 'steam_id must be a string (SteamID64).');
  }
  const trimmed = value.trim();
  if (!STEAM_ID_PATTERN.test(trimmed)) {
    throw new FieldError('invalid_steam_id', 'steam_id must be a 17-digit SteamID64 starting with 7656119.');
  }
  return trimmed;
}

function readReason(value: unknown): BanReason {
  if (typeof value !== 'string' || !(BAN_REASONS as readonly string[]).includes(value)) {
    throw new FieldError('invalid_reason', `reason must be one of: ${BAN_REASONS.join(', ')}.`);
  }
  return value as BanReason;
}

function readOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new FieldError('invalid_request', `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new FieldError('invalid_request', `${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

function parseIso(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, 'invalid_request', `${field} must be an ISO 8601 timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function parseOptionalBool(value: string | null, field: string): boolean | null {
  if (value === null || value === '') return null;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new ApiError(400, 'invalid_request', `${field} must be true or false.`);
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseReasons(value: string | null): BanReason[] | null {
  if (!value) return null;
  const parts = splitCsv(value);
  if (parts.length === 0) return null;
  if (parts.length > 8) {
    throw new ApiError(400, 'invalid_request', 'reason accepts at most 8 values.');
  }

  const reasons: BanReason[] = [];
  for (const part of parts) {
    if (!(BAN_REASONS as readonly string[]).includes(part)) {
      throw new ApiError(400, 'invalid_reason', `reason must be one of: ${BAN_REASONS.join(', ')}.`);
    }
    if (!reasons.includes(part as BanReason)) reasons.push(part as BanReason);
  }
  return reasons;
}

function parseSteamIds(value: string | null): string[] | null {
  if (!value) return null;
  const parts = splitCsv(value);
  if (parts.length === 0) return null;
  if (parts.length > 50) {
    throw new ApiError(400, 'invalid_request', 'steam_id accepts at most 50 values per request.');
  }
  return [...new Set(parts.map((part) => parseSteamId(part)))];
}

function parseServers(value: string | null): string[] | null {
  if (!value) return null;
  const parts = splitCsv(value);
  if (parts.length === 0) return null;
  if (parts.length > 50) {
    throw new ApiError(400, 'invalid_request', 'server accepts at most 50 values per request.');
  }
  return [...new Set(parts.map((part) => parseServerId(part)))];
}
