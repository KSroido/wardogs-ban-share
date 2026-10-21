/**
 * Wire types for the Wardogs federated ban list.
 *
 * Field names deliberately mirror the JSON on the wire (snake_case) so that a
 * response can be handed to the rest of your code without a mapping layer.
 */

/**
 * The eight reasons the federation accepts.
 *
 * `ownreason` (free-form) is the only reason that requires a `note`; use it
 * when none of the other seven tags describe the case.
 */
export const BAN_REASONS = [
  'cheat',
  'rulebreak',
  'chattroll',
  'gametroll',
  'racism',
  'foreignofserverlocation',
  'steamrisk',
  'ownreason',
] as const;

export type BanReason = (typeof BAN_REASONS)[number];

/** Lifecycle of a ban. `expired` is derived from `expires_at`, not stored. */
export type BanStatus = 'active' | 'expired' | 'revoked';

/** A server that is no longer trusted can be defederated; its history stays. */
export type ServerStatus = 'active' | 'defederated';

export interface ServerRef {
  /** Stable slug, e.g. `wardogs-main`. Never changes, unlike the display name. */
  id: string;
  /** Human readable name of the server that issued the ban. */
  name: string;
  /**
   * Where that server sits (`CN`, `EU-Frankfurt`, …). A reader uses it to judge
   * whether a ban came from a server in its own region or from abroad.
   */
  location?: string | null;
}

export interface Server extends ServerRef {
  /** 管理方：同一管理方在同一地理位置的多台服共用一个 key */
  owner: string | null;
  location: string | null;
  status: ServerStatus;
  note: string | null;
  created_at: string;
}

/**
 * Aggregate of every non-revoked ban recorded for one SteamID.
 *
 * This is the "how many servers reported this player" column. It is a read
 * model in the `player_stats` table of the same D1 database, so it can be
 * rebuilt from the ban records at any time.
 *
 * Counts are over non-revoked bans; `active_*` additionally excludes bans whose
 * `expires_at` has passed. A player whose bans were all revoked has no row.
 */
export interface PlayerReports {
  steam_id: string;
  /** Distinct servers that reported this player. The headline number. */
  server_count: number;
  /** Distinct servers with a ban that is still in force right now. */
  active_server_count: number;
  ban_count: number;
  active_ban_count: number;
  permanent_count: number;
  /** Only reasons with a non-zero count are present. */
  reason_counts: Partial<Record<BanReason, number>>;
  first_reported_at: string | null;
  last_reported_at: string | null;
  updated_at: string;
}

/** A ban is always returned together with its player's aggregate. */
export interface Ban {
  id: string;
  server: ServerRef;
  /** SteamID64, 17 digits, always a string to survive JS number precision. */
  steam_id: string;
  /** Last known in-game name, if the reporting server sent one. */
  player_name: string | null;
  reason: BanReason;
  /** Free-form details. Required when `reason` is `ownreason`. */
  note: string | null;
  /** Optional proof: screenshot, clip, demo, chat log. */
  evidence_url: string | null;
  permanent: boolean;
  /** Null when `permanent` is true. */
  duration_days: number | null;
  /** ISO 8601 UTC timestamp, null when permanent. */
  expires_at: string | null;
  status: BanStatus;
  /** The reporting server's own case number, used for idempotent retries. */
  external_case_id: string | null;
  /** When the ban was uploaded to the federation. */
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  reports: PlayerReports;
}

export interface SubmitBanInput {
  steam_id: string;
  reason: BanReason;
  permanent: boolean;
  /** Required and >= 1 when `permanent` is false; must be omitted when true. */
  duration_days?: number | null;
  note?: string | null;
  evidence_url?: string | null;
  player_name?: string | null;
  external_case_id?: string | null;
}

export interface SubmitBanDuplicate {
  /** Index of the item in the submitted array. */
  index: number;
  /** Id of the ban that already exists. */
  id: string;
  steam_id: string;
  reason: BanReason;
  status: BanStatus;
}

export interface SubmitBanError {
  index: number;
  code: string;
  message: string;
}

export interface SubmitBansResult {
  created: Ban[];
  duplicates: SubmitBanDuplicate[];
  errors: SubmitBanError[];
}

export type ListStatus = BanStatus | 'all';

export interface ListBansQuery {
  /** Exclusive lower bound on `updated_at`. Use with `cursor` for exact resume. */
  since?: string;
  /** Opaque cursor from a previous `next_cursor`. */
  cursor?: string;
  /** Page size, 1-500, default 100. */
  limit?: number;
  reason?: BanReason | BanReason[];
  /** Exact SteamID64 match, up to 50 per request. */
  steam_id?: string | string[];
  /** Server slug, up to 50 per request. */
  server?: string | string[];
  permanent?: boolean;
  /**
   * Which records to return. Default `active`.
   * Use `all` when syncing, otherwise revocations are invisible.
   */
  status?: ListStatus;
}

export interface ListBansResult {
  data: Ban[];
  next_cursor: string | null;
  has_more: boolean;
  /** Server clock at the time of the response, useful for `since` bookkeeping. */
  server_time: string;
}

export interface ListServersResult {
  data: Server[];
}

export interface PlayerDetail {
  steam_id: string;
  reports: PlayerReports;
  /** Newest first. `reports` is the same aggregate repeated on every ban. */
  bans: Ban[];
  /**
   * 命中本地白名单时为 `true`：这是 SDK 本地结果，没有查询服务端，
   * `reports` 全零、`bans` 为空。服务端响应里没有这个字段，默认 `false`。
   */
  whitelisted: boolean;
}

export type PlayerSort = 'servers' | 'active_servers' | 'bans' | 'active_bans' | 'last_reported_at';

export interface ListPlayersQuery {
  /**
   * Sort order, descending. Default `servers` (most reported players first).
   * `last_reported_at` is the freshest intelligence.
   */
  sort?: PlayerSort;
  /** 1-200, default 50. */
  limit?: number;
  /** Default 0, max 10000. */
  offset?: number;
}

export interface ListPlayersResult {
  data: PlayerReports[];
  total: number;
  limit: number;
  offset: number;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  request_id?: string;
}

export interface HealthResult {
  ok: boolean;
  time: string;
  version: string;
}
