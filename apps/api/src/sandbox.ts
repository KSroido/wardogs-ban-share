/**
 * Sandbox responses for test keys.
 *
 * A test key is a normal row in `api_keys` with `is_test = 1`; authenticating it is
 * the only statement such a request runs. Nothing in this module accepts a D1 handle,
 * so a test request cannot read real bans or write anything.
 *
 * No sandbox identity is hardcoded here. The Worker resolves one variable at runtime
 * (`SANDBOX`, JSON) and echoes what it finds:
 *
 *   SANDBOX={
 *     "server": { "id": "sandbox", "name": "Sandbox Test Server" },
 *     "steam_id": "76561198000000000",
 *     "ban": {
 *       "reason": "cheat",
 *       "permanent": true,
 *       "player_name": "sandbox_player",
 *       "note": "Demo record",
 *       "evidence_url": "https://example.com/demo.png",
 *       "external_case_id": "sandbox-demo-1",
 *       "created_at": "2026-01-01T00:00:00.000Z"
 *     }
 *   }
 */
import type { Ban, BanReason, PlayerReports, Server, SubmitBanDuplicate, SubmitBanError } from '@wardogs/banlist';
import { ApiError } from './errors';
import { validateSubmitBan } from './validation';

const BAN_REASONS: readonly string[] = [
  'cheat',
  'rulebreak',
  'chattroll',
  'gametroll',
  'racism',
  'foreignofserverlocation',
  'steamrisk',
  'ownreason',
];

export interface SandboxBan {
  reason: BanReason;
  permanent: boolean;
  duration_days: number | null;
  player_name: string | null;
  note: string | null;
  evidence_url: string | null;
  external_case_id: string | null;
  created_at: string;
}

export interface SandboxConfig {
  serverId: string;
  serverName: string;
  steamId: string;
  ban: SandboxBan;
}

/**
 * Parse the runtime variable. Returns null when unset; throws when it is set but
 * unusable, so a half-configured deployment fails loudly instead of inventing data.
 */
export function parseSandboxConfig(raw: string | undefined | null): SandboxConfig | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(500, 'sandbox_misconfigured', 'SANDBOX must be valid JSON.');
  }

  const fail = (what: string): never => {
    throw new ApiError(500, 'sandbox_misconfigured', `SANDBOX.${what} is missing or invalid.`);
  };

  const root = parsed as Record<string, unknown>;
  const server = (root.server ?? {}) as Record<string, unknown>;
  const ban = (root.ban ?? {}) as Record<string, unknown>;

  const serverId = typeof server.id === 'string' ? server.id.trim() : '';
  const serverName = typeof server.name === 'string' ? server.name.trim() : '';
  const steamId = typeof root.steam_id === 'string' ? root.steam_id.trim() : '';
  const reason = typeof ban.reason === 'string' ? ban.reason : '';

  if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(serverId)) fail('server.id');
  if (serverName.length < 2 || serverName.length > 64) fail('server.name');
  if (!/^7656119\d{10}$/.test(steamId)) fail('steam_id');
  if (!BAN_REASONS.includes(reason)) fail('ban.reason');

  const permanent = ban.permanent === undefined ? true : ban.permanent === true;
  const durationDays = permanent ? null : typeof ban.duration_days === 'number' ? ban.duration_days : null;
  if (!permanent && (durationDays === null || durationDays < 1 || durationDays > 36500)) {
    fail('ban.duration_days');
  }

  const optionalString = (value: unknown, max: number): string | null => {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text === '' ? null : text.slice(0, max);
  };

  const createdAt = typeof ban.created_at === 'string' ? ban.created_at : '';
  if (createdAt && Number.isNaN(Date.parse(createdAt))) fail('ban.created_at');

  return {
    serverId,
    serverName,
    steamId,
    ban: {
      reason: reason as BanReason,
      permanent,
      duration_days: durationDays,
      player_name: optionalString(ban.player_name, 64),
      note: optionalString(ban.note, 1000),
      evidence_url: optionalString(ban.evidence_url, 512),
      external_case_id: optionalString(ban.external_case_id, 128),
      created_at: createdAt || new Date(0).toISOString(),
    },
  };
}

/** A test key cannot answer anything until the deployment says who the sandbox is. */
export function requireSandboxConfig(raw: string | undefined | null): SandboxConfig {
  const config = parseSandboxConfig(raw);
  if (!config) {
    throw new ApiError(
      503,
      'sandbox_unconfigured',
      'Test keys are disabled: set the SANDBOX variable on this Worker first.',
    );
  }
  return config;
}

/** The demo record's id is derived, not stored: one record, stable across requests. */
export function demoBanId(config: SandboxConfig): string {
  return `${config.serverId}_demo_ban`;
}

export function sandboxServer(config: SandboxConfig): Server {
  return {
    id: config.serverId,
    name: config.serverName,
    status: 'active',
    owner: null,
    location: null,
    note: null,
    created_at: config.ban.created_at,
  };
}

export function sandboxReports(config: SandboxConfig, nowIso: string): PlayerReports {
  return {
    steam_id: config.steamId,
    server_count: 1,
    active_server_count: 1,
    ban_count: 1,
    active_ban_count: 1,
    permanent_count: config.ban.permanent ? 1 : 0,
    reason_counts: { [config.ban.reason]: 1 },
    first_reported_at: config.ban.created_at,
    last_reported_at: nowIso,
    updated_at: nowIso,
  };
}

export function emptyReports(steamId: string, nowIso: string): PlayerReports {
  return {
    steam_id: steamId,
    server_count: 0,
    active_server_count: 0,
    ban_count: 0,
    active_ban_count: 0,
    permanent_count: 0,
    reason_counts: {},
    first_reported_at: null,
    last_reported_at: null,
    updated_at: nowIso,
  };
}

/** The one record a test key can pull. */
export function demoBan(config: SandboxConfig, nowIso: string): Ban {
  return {
    id: demoBanId(config),
    server: { id: config.serverId, name: config.serverName },
    steam_id: config.steamId,
    player_name: config.ban.player_name,
    reason: config.ban.reason,
    note: config.ban.note,
    evidence_url: config.ban.evidence_url,
    permanent: config.ban.permanent,
    duration_days: config.ban.duration_days,
    expires_at: null,
    status: 'active',
    external_case_id: config.ban.external_case_id,
    created_at: config.ban.created_at,
    updated_at: nowIso,
    revoked_at: null,
    revoke_reason: null,
    reports: sandboxReports(config, nowIso),
  };
}

export interface SandboxSubmitResult {
  created: Ban[];
  duplicates: SubmitBanDuplicate[];
  errors: SubmitBanError[];
}

/**
 * Validate a submission exactly like the real endpoint, then hand back synthetic
 * records. Nothing is written, so ids are derived from the batch index and a repeated
 * SteamID inside one batch is reported as a duplicate.
 */
export function sandboxSubmit(
  rawBans: unknown[],
  config: SandboxConfig,
  nowIso: string,
): SandboxSubmitResult {
  const created: Ban[] = [];
  const duplicates: SubmitBanDuplicate[] = [];
  const errors: SubmitBanError[] = [];
  const seen = new Map<string, string>();

  rawBans.forEach((raw, index) => {
    const validation = validateSubmitBan(raw, nowIso);
    if (!validation.ok) {
      errors.push({ index, code: validation.code, message: validation.message });
      return;
    }

    const value = validation.value;
    const earlier = seen.get(value.steam_id);
    if (earlier) {
      duplicates.push({
        index,
        id: earlier,
        steam_id: value.steam_id,
        reason: value.reason,
        status: 'active',
      });
      return;
    }

    const id = `${config.serverId}_test_ban_${index + 1}`;
    seen.set(value.steam_id, id);
    created.push({
      id,
      server: { id: config.serverId, name: config.serverName },
      steam_id: value.steam_id,
      player_name: value.player_name,
      reason: value.reason,
      note: value.note,
      evidence_url: value.evidence_url,
      permanent: value.permanent,
      duration_days: value.duration_days,
      expires_at: value.expires_at,
      status: 'active',
      external_case_id: value.external_case_id,
      created_at: nowIso,
      updated_at: nowIso,
      revoked_at: null,
      revoke_reason: null,
      reports: sandboxReports(config, nowIso),
    });
  });

  return { created, duplicates, errors };
}

export interface SandboxQuery {
  status: string;
  steamIds: string[] | null;
  reasons: string[] | null;
  servers: string[] | null;
  permanent: boolean | null;
  since: string | null;
}

/** Does the demo record satisfy a /v1/bans query? Filters are honoured, not ignored. */
export function demoMatchesQuery(config: SandboxConfig, query: SandboxQuery): boolean {
  if (query.status === 'revoked' || query.status === 'expired') return false;
  if (query.permanent === false && config.ban.permanent) return false;
  if (query.permanent === true && !config.ban.permanent) return false;
  if (query.reasons && !query.reasons.includes(config.ban.reason)) return false;
  if (query.servers && !query.servers.includes(config.serverId)) return false;
  if (query.steamIds && !query.steamIds.includes(config.steamId)) return false;
  if (query.since && config.ban.created_at <= query.since) return false;
  return true;
}

/** Test keys may only revoke the demo record, and only in their own response. */
export function sandboxRevoke(
  config: SandboxConfig,
  banId: string,
  nowIso: string,
  reason: string | null,
): Ban {
  if (banId !== demoBanId(config)) {
    throw new ApiError(404, 'not_found', 'No such ban in the sandbox.');
  }

  return {
    ...demoBan(config, nowIso),
    status: 'revoked',
    revoked_at: nowIso,
    revoke_reason: reason,
    reports: emptyReports(config.steamId, nowIso),
  };
}
