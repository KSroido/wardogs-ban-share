import { BAN_REASONS } from '@wardogs/banlist';
import type { BanReason, PlayerReports } from '@wardogs/banlist';

/**
 * Per-SteamID read model, stored in the same D1 database as the ban records.
 *
 * It is a derived table, never the source of truth: every row can be rebuilt
 * from `bans` with POST /admin/reindex (and the nightly cron does exactly that).
 */

export interface StatsRow {
  steam_id: string | null;
  server_count: number;
  active_server_count: number;
  ban_count: number;
  active_ban_count: number;
  permanent_count: number;
  first_reported_at: string | null;
  last_reported_at: string | null;
  [key: string]: unknown;
}

export interface PlayerStatsRow {
  steam_id: string;
  server_count: number;
  active_server_count: number;
  ban_count: number;
  active_ban_count: number;
  permanent_count: number;
  reason_counts: string;
  first_reported_at: string | null;
  last_reported_at: string | null;
  updated_at: string;
}

const REASON_SUMS = BAN_REASONS.map(
  (reason) => `SUM(CASE WHEN reason = '${reason}' THEN 1 ELSE 0 END) AS reason_${reason}`,
).join(',\n         ');

// Two `?` for the "still in force" check, then the steam_id filter / range.
const AGGREGATE_COLUMNS = `
         COUNT(DISTINCT server_id) AS server_count,
         COUNT(DISTINCT CASE WHEN status = 'active' AND (expires_at IS NULL OR expires_at > ?) THEN server_id END) AS active_server_count,
         COUNT(*) AS ban_count,
         SUM(CASE WHEN status = 'active' AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active_ban_count,
         SUM(CASE WHEN permanent = 1 THEN 1 ELSE 0 END) AS permanent_count,
         MIN(created_at) AS first_reported_at,
         MAX(created_at) AS last_reported_at,
         ${REASON_SUMS}`;

const UPSERT_PLAYER_STATS = `
  INSERT INTO player_stats (
    steam_id, server_count, active_server_count, ban_count, active_ban_count,
    permanent_count, reason_counts, first_reported_at, last_reported_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (steam_id) DO UPDATE SET
    server_count = excluded.server_count,
    active_server_count = excluded.active_server_count,
    ban_count = excluded.ban_count,
    active_ban_count = excluded.active_ban_count,
    permanent_count = excluded.permanent_count,
    reason_counts = excluded.reason_counts,
    first_reported_at = excluded.first_reported_at,
    last_reported_at = excluded.last_reported_at,
    updated_at = excluded.updated_at`;

export function reportsFromStatsRow(row: StatsRow, fallbackSteamId: string, nowIso: string): PlayerReports {
  const reasonCounts: Partial<Record<BanReason, number>> = {};
  for (const reason of BAN_REASONS) {
    const count = Number(row[`reason_${reason}`] ?? 0);
    if (count > 0) reasonCounts[reason] = count;
  }

  return {
    steam_id: row.steam_id ?? fallbackSteamId,
    server_count: Number(row.server_count ?? 0),
    active_server_count: Number(row.active_server_count ?? 0),
    ban_count: Number(row.ban_count ?? 0),
    active_ban_count: Number(row.active_ban_count ?? 0),
    permanent_count: Number(row.permanent_count ?? 0),
    reason_counts: reasonCounts,
    first_reported_at: row.first_reported_at,
    last_reported_at: row.last_reported_at,
    updated_at: nowIso,
  };
}

export function reportsFromPlayerStatsRow(row: PlayerStatsRow): PlayerReports {
  let reasonCounts: Partial<Record<BanReason, number>> = {};
  try {
    reasonCounts = JSON.parse(row.reason_counts) as Partial<Record<BanReason, number>>;
  } catch {
    reasonCounts = {};
  }

  return {
    steam_id: row.steam_id,
    server_count: row.server_count,
    active_server_count: row.active_server_count,
    ban_count: row.ban_count,
    active_ban_count: row.active_ban_count,
    permanent_count: row.permanent_count,
    reason_counts: reasonCounts,
    first_reported_at: row.first_reported_at,
    last_reported_at: row.last_reported_at,
    updated_at: row.updated_at,
  };
}

/** Recompute one player straight from the ban records. Exact, not incremental. */
export async function computePlayerReports(
  db: D1Database,
  steamId: string,
  nowIso: string,
): Promise<PlayerReports> {
  const row = await db
    .prepare(
      `SELECT steam_id, ${AGGREGATE_COLUMNS}
         FROM bans
        WHERE status <> 'revoked' AND steam_id = ?`,
    )
    .bind(nowIso, nowIso, steamId)
    .first<StatsRow>();

  if (!row) return emptyReportsFor(steamId, nowIso);
  return reportsFromStatsRow(row, steamId, nowIso);
}

export async function upsertReports(db: D1Database, reports: PlayerReports): Promise<void> {
  await db
    .prepare(UPSERT_PLAYER_STATS)
    .bind(
      reports.steam_id,
      reports.server_count,
      reports.active_server_count,
      reports.ban_count,
      reports.active_ban_count,
      reports.permanent_count,
      JSON.stringify(reports.reason_counts),
      reports.first_reported_at,
      reports.last_reported_at,
      reports.updated_at,
    )
    .run();
}

/**
 * Recompute and store one player. A player whose bans were all revoked loses
 * the row entirely, so the "most reported" list never shows stale entries.
 */
export async function refreshPlayer(
  db: D1Database,
  steamId: string,
  nowIso: string,
): Promise<PlayerReports> {
  const reports = await computePlayerReports(db, steamId, nowIso);
  if (reports.ban_count === 0) {
    await db.prepare('DELETE FROM player_stats WHERE steam_id = ?').bind(steamId).run();
  } else {
    await upsertReports(db, reports);
  }
  return reports;
}

/** Load aggregates for a page of bans in one query. */
export async function loadReports(db: D1Database, steamIds: string[]): Promise<Map<string, PlayerReports>> {
  const unique = [...new Set(steamIds)];
  if (unique.length === 0) return new Map();

  const placeholders = unique.map(() => '?').join(', ');
  const result = await db
    .prepare(`SELECT * FROM player_stats WHERE steam_id IN (${placeholders})`)
    .bind(...unique)
    .all<PlayerStatsRow>();

  return new Map((result.results ?? []).map((row) => [row.steam_id, reportsFromPlayerStatsRow(row)]));
}

/**
 * Full rebuild. Keyset paginated so it can run on a Worker without loading the
 * whole ban table into memory. Rows not touched by the run are deleted.
 */
export async function reindexAll(db: D1Database, nowIso: string, pageSize = 500): Promise<number> {
  let lastSteamId = '';
  let total = 0;

  for (;;) {
    const result = await db
      .prepare(
        `SELECT steam_id, ${AGGREGATE_COLUMNS}
           FROM bans
          WHERE status <> 'revoked' AND steam_id > ?
          GROUP BY steam_id
          ORDER BY steam_id ASC
          LIMIT ?`,
      )
      .bind(nowIso, nowIso, lastSteamId, pageSize)
      .all<StatsRow>();

    const rows = result.results ?? [];
    if (rows.length === 0) break;

    const statements = rows.map((row) => {
      const reports = reportsFromStatsRow(row, row.steam_id ?? '', nowIso);
      return db
        .prepare(UPSERT_PLAYER_STATS)
        .bind(
          reports.steam_id,
          reports.server_count,
          reports.active_server_count,
          reports.ban_count,
          reports.active_ban_count,
          reports.permanent_count,
          JSON.stringify(reports.reason_counts),
          reports.first_reported_at,
          reports.last_reported_at,
          reports.updated_at,
        );
    });

    for (let offset = 0; offset < statements.length; offset += 50) {
      await db.batch(statements.slice(offset, offset + 50));
    }

    total += rows.length;
    lastSteamId = rows[rows.length - 1]!.steam_id ?? lastSteamId;
    if (rows.length < pageSize) break;
  }

  await db.prepare('DELETE FROM player_stats WHERE updated_at < ?').bind(nowIso).run();
  return total;
}

function emptyReportsFor(steamId: string, nowIso: string): PlayerReports {
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
