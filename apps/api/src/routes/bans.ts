import { Hono } from 'hono';
import type { Ban, BanReason, SubmitBanDuplicate, SubmitBanError } from '@wardogs/banlist';
import type { AppEnv } from '../env';
import { canTouchServer, requireApiKey, requireScope, resolveWriteServer } from '../auth';
import { auditStatement } from '../db';
import { ApiError } from '../errors';
import { readJson } from '../http';
import { newId } from '../ids';
import { BAN_SELECT, banFromRow, deriveStatus, emptyReports, loadBan, type BanRow } from '../mappers';
import { loadReports, refreshPlayer } from '../stats';
import {
  decodeCursor,
  encodeCursor,
  maxSubmitBatch,
  parseListQuery,
  statusClause,
  validateSubmitBan,
  type ValidatedBan,
} from '../validation';

export const bansRoutes = new Hono<AppEnv>();

const INSERT_BAN = `
  INSERT INTO bans (
    id, server_id, steam_id, player_name, reason, note, evidence_url,
    permanent, duration_days, expires_at, status, external_case_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
`;

interface ExistingBanRow {
  id: string;
  steam_id: string;
  reason: string;
  status: 'active' | 'revoked';
  expires_at: string | null;
}

bansRoutes.get('/', async (c) => {
  const auth = await requireApiKey(c);
  requireScope(auth, 'bans:read');

  const query = parseListQuery(new URL(c.req.url).searchParams);
  const now = new Date();
  const nowIso = now.toISOString();

  const clauses: string[] = [];
  const params: Array<string | number> = [];

  const status = statusClause(query.status, nowIso);
  if (status) {
    clauses.push(status.sql);
    params.push(...status.params);
  }

  if (query.since) {
    clauses.push('b.updated_at > ?');
    params.push(query.since);
  }

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    clauses.push('(b.updated_at > ? OR (b.updated_at = ? AND b.id > ?))');
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }

  if (query.reasons) {
    clauses.push(`b.reason IN (${query.reasons.map(() => '?').join(', ')})`);
    params.push(...query.reasons);
  }

  if (query.steamIds) {
    clauses.push(`b.steam_id IN (${query.steamIds.map(() => '?').join(', ')})`);
    params.push(...query.steamIds);
  }

  if (query.servers) {
    clauses.push(`b.server_id IN (${query.servers.map(() => '?').join(', ')})`);
    params.push(...query.servers);
  }

  if (query.permanent !== null) {
    clauses.push('b.permanent = ?');
    params.push(query.permanent ? 1 : 0);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const result = await c.env.DB.prepare(
    `${BAN_SELECT} ${where} ORDER BY b.updated_at ASC, b.id ASC LIMIT ?`,
  )
    .bind(...params, query.limit + 1)
    .all<BanRow>();

  const all = result.results ?? [];
  const hasMore = all.length > query.limit;
  const page = all.slice(0, query.limit);

  const reports = await loadReports(
    c.env.DB,
    page.map((row) => row.steam_id),
  );

  const nowMs = now.getTime();
  const data = page.map((row) =>
    banFromRow(row, nowMs, reports.get(row.steam_id) ?? emptyReports(row.steam_id, nowIso)),
  );

  const last = page[page.length - 1];

  return c.json({
    data,
    next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
    has_more: hasMore,
    server_time: nowIso,
  });
});

bansRoutes.post('/', async (c) => {
  const auth = await requireApiKey(c);
  requireScope(auth, 'bans:write');

  const body = await readJson(c);
  const rawBans = extractBans(body);
  // 组 key 必须在请求里指明是哪台服（组里只有一台时自动取那一台）
  const targetServerId = await resolveWriteServer(c.env.DB, auth, requestedServerId(body));

  if (rawBans.length === 0) {
    throw new ApiError(400, 'invalid_request', 'bans must contain at least one entry.');
  }
  if (rawBans.length > maxSubmitBatch()) {
    throw new ApiError(400, 'batch_too_large', `At most ${maxSubmitBatch()} bans per request.`);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const db = c.env.DB;

  const created: Ban[] = [];
  const duplicates: SubmitBanDuplicate[] = [];
  const errors: SubmitBanError[] = [];
  const audit: D1PreparedStatement[] = [];

  for (let index = 0; index < rawBans.length; index += 1) {
    const validation = validateSubmitBan(rawBans[index], nowIso);
    if (!validation.ok) {
      errors.push({ index, code: validation.code, message: validation.message });
      continue;
    }

    const value = validation.value;
    const duplicate = await findDuplicate(db, targetServerId, value, nowIso);

    if (duplicate) {
      duplicates.push(toDuplicate(index, duplicate, now.getTime()));
      continue;
    }

    const id = newId('ban');

    try {
      await db
        .prepare(INSERT_BAN)
        .bind(
          id,
          targetServerId,
          value.steam_id,
          value.player_name,
          value.reason,
          value.note,
          value.evidence_url,
          value.permanent ? 1 : 0,
          value.duration_days,
          value.expires_at,
          value.external_case_id,
          nowIso,
          nowIso,
        )
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await findDuplicate(db, targetServerId, value, nowIso);
        if (raced) {
          duplicates.push(toDuplicate(index, raced, now.getTime()));
          continue;
        }
      }
      console.error('ban insert failed', error);
      errors.push({ index, code: 'internal', message: 'Failed to store the ban.' });
      continue;
    }

    const row = await loadBan(db, id);
    if (row) {
      let reports = emptyReports(value.steam_id, nowIso);
      try {
        reports = await refreshPlayer(db, value.steam_id, nowIso);
      } catch (error) {
        // The ban is stored; the daily reindex or /admin/reindex repairs stats.
        console.error('player stats refresh failed', error);
      }
      created.push(banFromRow(row, now.getTime(), reports));
    }

    audit.push(
      auditStatement(db, {
        actorType: 'server',
        actorId: targetServerId,
        action: 'ban.create',
        target: id,
        detail: {
          steam_id: value.steam_id,
          reason: value.reason,
          permanent: value.permanent,
          duration_days: value.duration_days,
          key_id: auth.keyId,
        },
      }),
    );
  }

  if (audit.length > 0) {
    try {
      await db.batch(audit);
    } catch (error) {
      console.error('audit batch failed', error);
    }
  }

  const httpStatus =
    errors.length > 0
      ? created.length > 0 || duplicates.length > 0
        ? 207
        : 422
      : created.length > 0
        ? 201
        : 200;

  return c.json({ created, duplicates, errors }, httpStatus);
});

bansRoutes.post('/:id/revoke', async (c) => {
  const auth = await requireApiKey(c);
  requireScope(auth, 'bans:write');

  const id = c.req.param('id');
  const row = await loadBan(c.env.DB, id);

  if (!row) throw new ApiError(404, 'not_found', 'Ban not found.');
  if (!(await canTouchServer(c.env.DB, auth, row.server_id))) {
    throw new ApiError(403, 'forbidden', 'A key may only revoke bans of the servers it covers.');
  }

  const nowIso = new Date().toISOString();

  if (row.status !== 'revoked') {
    const body = await readOptionalBody(c);
    const reason = optionalReason(body);

    await c.env.DB.prepare(
      `UPDATE bans SET status = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso, reason, nowIso, id)
      .run();

    try {
      await refreshPlayer(c.env.DB, row.steam_id, nowIso);
    } catch (error) {
      console.error('player stats refresh failed', error);
    }

    await auditStatement(c.env.DB, {
      actorType: 'server',
      actorId: row.server_id,
      action: 'ban.revoke',
      target: id,
      detail: { reason, key_id: auth.keyId },
    }).run();
  }

  const updated = await loadBan(c.env.DB, id);
  if (!updated) throw new ApiError(404, 'not_found', 'Ban not found.');

  const reports = await loadReports(c.env.DB, [updated.steam_id]);
  return c.json(
    banFromRow(
      updated,
      Date.now(),
      reports.get(updated.steam_id) ?? emptyReports(updated.steam_id, nowIso),
    ),
  );
});

async function findDuplicate(
  db: D1Database,
  serverId: string,
  value: ValidatedBan,
  nowIso: string,
): Promise<ExistingBanRow | null> {
  if (value.external_case_id) {
    const byCase = await db
      .prepare(
        `SELECT id, steam_id, reason, status, expires_at FROM bans
          WHERE server_id = ? AND external_case_id = ?`,
      )
      .bind(serverId, value.external_case_id)
      .first<ExistingBanRow>();
    if (byCase) return byCase;
  }

  return db
    .prepare(
      `SELECT id, steam_id, reason, status, expires_at FROM bans
        WHERE server_id = ? AND steam_id = ? AND status = 'active'
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(serverId, value.steam_id, nowIso)
    .first<ExistingBanRow>();
}

function toDuplicate(index: number, row: ExistingBanRow, nowMs: number): SubmitBanDuplicate {
  return {
    index,
    id: row.id,
    steam_id: row.steam_id,
    reason: row.reason as BanReason,
    status: deriveStatus(row, nowMs),
  };
}

/** 组 key 用：请求顶层可带 `server_id` 指明具体是哪台服 */
function requestedServerId(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).server_id;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function extractBans(body: unknown): unknown[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_request', 'Body must be a JSON object: { "bans": [ ... ] }.');
  }

  const bans = (body as Record<string, unknown>).bans;
  if (!Array.isArray(bans)) {
    throw new ApiError(400, 'invalid_request', 'bans must be an array.');
  }
  return bans;
}

function isUniqueViolation(error: unknown): boolean {
  return String((error as Error)?.message ?? '').toLowerCase().includes('unique constraint');
}

async function readOptionalBody(c: Parameters<typeof requireApiKey>[0]): Promise<Record<string, unknown>> {
  try {
    const raw = await c.req.json();
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function optionalReason(body: Record<string, unknown>): string | null {
  const value = body.reason;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}
