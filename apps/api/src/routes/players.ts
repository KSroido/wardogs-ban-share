import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireApiKey, requireScope } from '../auth';
import { ApiError } from '../errors';
import { BAN_SELECT, banFromRow, emptyReports, type BanRow } from '../mappers';
import { computePlayerReports, loadReports, reportsFromPlayerStatsRow, type PlayerStatsRow } from '../stats';
import { demoBan, emptyReports as sandboxEmptyReports, requireSandboxConfig, sandboxReports } from '../sandbox';
import {
  parseLimit,
  parseOffset,
  parsePlayerSort,
  parseStatus,
  parseSteamId,
  statusClause,
} from '../validation';

export const playersRoutes = new Hono<AppEnv>();

const SORT_COLUMNS = {
  servers: 'server_count',
  active_servers: 'active_server_count',
  bans: 'ban_count',
  active_bans: 'active_ban_count',
  last_reported_at: 'last_reported_at',
} as const;

/**
 * The "how many servers reported this player" leaderboard. Reads only the
 * aggregate database; no ban details are exposed here.
 */
playersRoutes.get('/', async (c) => {
  const auth = await requireApiKey(c);
  requireScope(auth, 'bans:read');

  const params = new URL(c.req.url).searchParams;
  const sort = parsePlayerSort(params.get('sort'));
  const limit = parseLimit(params.get('limit'), 50, 200);
  const offset = parseOffset(params.get('offset'));

  // 测试 key：排行榜只有沙盒那一个玩家，绝不查询 player_stats。
  if (auth.sandbox) {
    const config = requireSandboxConfig(c.env.SANDBOX);
    return c.json({
      data: offset === 0 ? [sandboxReports(config, new Date().toISOString())] : [],
      total: 1,
      limit,
      offset,
      sandbox: true,
    });
  }

  const result = await c.env.DB.prepare(
    `SELECT * FROM player_stats ORDER BY ${SORT_COLUMNS[sort]} DESC, steam_id ASC LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all<PlayerStatsRow>();

  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM player_stats').first<{ n: number }>();

  return c.json({
    data: (result.results ?? []).map(reportsFromPlayerStatsRow),
    total: total?.n ?? 0,
    limit,
    offset,
  });
});

/**
 * One player: the cross-server aggregate plus every ban record (newest first).
 * This is the call a panel makes before deciding to kick.
 */
playersRoutes.get('/:steamId', async (c) => {
  const auth = await requireApiKey(c);
  requireScope(auth, 'bans:read');

  const steamId = parseSteamId(c.req.param('steamId'), 'steamId');
  const params = new URL(c.req.url).searchParams;
  const status = parseStatus(params.get('status'), 'all');
  const limit = parseLimit(params.get('limit'), 200, 500);

  // 测试 key：只认识沙盒里那个玩家，其他一律返回空聚合。
  if (auth.sandbox) {
    const config = requireSandboxConfig(c.env.SANDBOX);
    const nowIso = new Date().toISOString();

    if (steamId !== config.steamId) {
      return c.json({
        steam_id: steamId,
        reports: sandboxEmptyReports(steamId, nowIso),
        bans: [],
        sandbox: true,
      });
    }

    return c.json({
      steam_id: steamId,
      reports: sandboxReports(config, nowIso),
      bans: status === 'revoked' ? [] : [demoBan(config, nowIso)],
      sandbox: true,
      limit,
    });
  }

  const now = new Date();
  const nowIso = now.toISOString();

  const where = ['b.steam_id = ?'];
  const bindings: Array<string | number> = [steamId];

  const clause = statusClause(status, nowIso);
  if (clause) {
    where.push(clause.sql);
    bindings.push(...clause.params);
  }

  const rows = await c.env.DB.prepare(
    `${BAN_SELECT} WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
  )
    .bind(...bindings, limit)
    .all<BanRow>();

  const stored = await loadReports(c.env.DB, [steamId]);
  // If the read model is behind, compute on the fly rather than show zeros.
  const reports = stored.get(steamId) ?? (await computePlayerReports(c.env.DB, steamId, nowIso));

  return c.json({
    steam_id: steamId,
    reports,
    bans: (rows.results ?? []).map((row) => banFromRow(row, now.getTime(), reports)),
  });
});
