import type { Ban, BanReason, BanStatus, PlayerReports } from '@wardogs/banlist';

export interface BanRow {
  id: string;
  server_id: string;
  server_name: string;
  steam_id: string;
  player_name: string | null;
  reason: string;
  note: string | null;
  evidence_url: string | null;
  permanent: number;
  duration_days: number | null;
  expires_at: string | null;
  status: 'active' | 'revoked';
  external_case_id: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
  updated_at: string;
}

export const BAN_SELECT = `
  SELECT b.id, b.server_id, s.name AS server_name, b.steam_id, b.player_name, b.reason,
         b.note, b.evidence_url, b.permanent, b.duration_days, b.expires_at, b.status,
         b.external_case_id, b.revoked_at, b.revoke_reason, b.created_at, b.updated_at
    FROM bans b
    JOIN servers s ON s.id = b.server_id
`;

export function banFromRow(row: BanRow, nowMs: number, reports: PlayerReports): Ban {
  return {
    id: row.id,
    server: { id: row.server_id, name: row.server_name },
    steam_id: row.steam_id,
    player_name: row.player_name,
    reason: row.reason as BanReason,
    note: row.note,
    evidence_url: row.evidence_url,
    permanent: row.permanent === 1,
    duration_days: row.duration_days,
    expires_at: row.expires_at,
    status: deriveStatus(row, nowMs),
    external_case_id: row.external_case_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at,
    revoke_reason: row.revoke_reason,
    reports,
  };
}

export function deriveStatus(row: Pick<BanRow, 'status' | 'expires_at'>, nowMs: number): BanStatus {
  if (row.status === 'revoked') return 'revoked';
  if (row.expires_at && Date.parse(row.expires_at) <= nowMs) return 'expired';
  return 'active';
}

export async function loadBan(db: D1Database, id: string): Promise<BanRow | null> {
  return db.prepare(`${BAN_SELECT} WHERE b.id = ?`).bind(id).first<BanRow>();
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
