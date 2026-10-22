import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAdmin } from '../auth';
import { generateApiKey, hashSecret, keyPrefix } from '../crypto';
import { auditStatement, logAudit } from '../db';
import { ApiError } from '../errors';
import { asRecord, readJson, readOptionalJson } from '../http';
import { newId } from '../ids';
import { emptyReports, loadBan } from '../mappers';
import { loadReports, refreshPlayer, reindexAll } from '../stats';
import { parseLocation, parseOwner, parseServerId, parseSteamId } from '../validation';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', async (c, next) => {
  await requireAdmin(c);
  await next();
});

/** Create a member server. Only call this after the onboarding issue is approved. */
adminRoutes.post('/servers', async (c) => {
  const body = asRecord(await readJson(c));
  const name = requireString(body.name, 'name', 2, 64);
  const note = optionalString(body.note, 'note', 500);
  // 接入申请必填：服务器地理位置。management 方的 owner 不填就当「这台服自己一个管理方」。
  const location = parseLocation(body.location);
  const requestedId =
    body.id === undefined || body.id === null ? null : parseServerId(String(body.id), 'id');

  const db = c.env.DB;
  const id = requestedId ? requestedId : await allocateServerId(db, slugify(name));
  const owner = body.owner === undefined || body.owner === null ? id : parseOwner(body.owner);

  if (requestedId) {
    const exists = await db.prepare('SELECT 1 AS x FROM servers WHERE id = ?').bind(requestedId).first();
    if (exists) throw new ApiError(409, 'conflict', `Server id "${requestedId}" is already taken.`);
  }

  const nowIso = new Date().toISOString();

  await db.prepare(
    `INSERT INTO servers (id, name, owner, location, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  )
    .bind(id, name, owner, location, note, nowIso, nowIso)
    .run();

  await logAudit(db, { actorType: 'admin', actorId: 'admin', action: 'server.create', target: id, detail: { name } });

  return c.json({ id, name, owner, location, status: 'active', note, created_at: nowIso }, 201);
});

adminRoutes.get('/servers', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.owner, s.location, s.status, s.note, s.created_at,
            (SELECT COUNT(*) FROM api_keys k WHERE k.server_id = s.id AND k.revoked_at IS NULL) AS active_keys,
            (SELECT COUNT(*) FROM bans b WHERE b.server_id = s.id) AS ban_count
       FROM servers s
      ORDER BY s.created_at ASC`,
  ).all();

  return c.json({ data: result.results ?? [] });
});

adminRoutes.patch('/servers/:id', async (c) => {
  const id = parseServerId(c.req.param('id'), 'id');
  const body = asRecord(await readJson(c));

  const current = await c.env.DB.prepare('SELECT id, name, owner, location, status, note FROM servers WHERE id = ?')
    .bind(id)
    .first<{ id: string; name: string; owner: string | null; location: string | null; status: string; note: string | null }>();

  if (!current) throw new ApiError(404, 'not_found', 'Server not found.');

  const name = body.name === undefined ? current.name : requireString(body.name, 'name', 2, 64);
  const note = body.note === undefined ? current.note : optionalString(body.note, 'note', 500);
  const status = body.status === undefined ? current.status : parseServerStatus(body.status);
  const owner = body.owner === undefined ? current.owner : parseOwner(body.owner);
  const location = body.location === undefined ? current.location : parseLocation(body.location);

  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE servers SET name = ?, owner = ?, location = ?, status = ?, note = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(name, owner, location, status, note, nowIso, id)
    .run();

  await logAudit(c.env.DB, {
    actorType: 'admin',
    actorId: 'admin',
    action: 'server.update',
    target: id,
    detail: { name, owner, location, status, note },
  });

  return c.json({ id, name, owner, location, status, note, updated_at: nowIso });
});

/**
 * Issue a key. The plaintext is returned once and never stored; the database
 * only keeps SHA-256(key) plus an 8 character prefix for lookup.
 */
adminRoutes.post('/servers/:id/keys', async (c) => {
  const id = parseServerId(c.req.param('id'), 'id');

  const server = await c.env.DB.prepare('SELECT id, owner, location, status FROM servers WHERE id = ?')
    .bind(id)
    .first<{ id: string; owner: string | null; location: string | null; status: string }>();

  if (!server) throw new ApiError(404, 'not_found', 'Server not found.');
  if (server.status !== 'active') {
    throw new ApiError(409, 'server_defederated', 'Cannot issue keys for a defederated server.');
  }

  const body = asRecord(await readOptionalJson(c));
  const label = optionalString(body.label, 'label', 100);
  const scopes = parseScopes(body.scopes);
  // group=true：发给「该管理方 + 该地理位置」下所有服共用的 key（server_id 置空）
  const asGroup = body.group === true || body.group === 'true';
  if (asGroup && (!server.owner || !server.location)) {
    throw new ApiError(409, 'missing_group', 'This server has no owner/location, cannot issue a group key.');
  }
  const key = generateApiKey();
  const keyId = newId('key');
  const nowIso = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, server_id, owner, location, prefix, key_hash, scopes, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      keyId,
      asGroup ? null : id,
      asGroup ? server.owner : null,
      asGroup ? server.location : null,
      keyPrefix(key),
      await hashSecret(key),
      scopes.join(' '),
      label,
      nowIso,
    )
    .run();

  await logAudit(c.env.DB, {
    actorType: 'admin',
    actorId: 'admin',
    action: 'key.issue',
    target: keyId,
    detail: { server_id: id, group: asGroup, owner: asGroup ? server.owner : null, location: asGroup ? server.location : null, scopes, label },
  });

  return c.json(
    {
      id: keyId,
      key,
      prefix: keyPrefix(key),
      server_id: asGroup ? null : id,
      owner: asGroup ? server.owner : null,
      location: asGroup ? server.location : null,
      scopes,
      label,
      created_at: nowIso,
      warning: 'Store this key now. It is stored as a SHA-256 hash and cannot be recovered.',
    },
    201,
  );
});

adminRoutes.get('/servers/:id/keys', async (c) => {
  const id = parseServerId(c.req.param('id'), 'id');

  const result = await c.env.DB.prepare(
    `SELECT id, server_id, owner, location, prefix, scopes, label, created_at, last_used_at, revoked_at
       FROM api_keys WHERE server_id = ? OR (owner = (SELECT owner FROM servers WHERE id = ?) AND location = (SELECT location FROM servers WHERE id = ?))
      ORDER BY created_at DESC`,
  )
    .bind(id, id, id)
    .all();

  return c.json({ data: result.results ?? [] });
});

adminRoutes.post('/keys/:id/revoke', async (c) => {
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();

  const result = await c.env.DB.prepare(
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  )
    .bind(nowIso, id)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    const existing = await c.env.DB.prepare('SELECT id FROM api_keys WHERE id = ?').bind(id).first();
    if (!existing) throw new ApiError(404, 'not_found', 'Key not found.');
  }

  await logAudit(c.env.DB, { actorType: 'admin', actorId: 'admin', action: 'key.revoke', target: id });
  return c.json({ id, revoked_at: nowIso });
});

/**
 * Issue a test key.
 *
 * Stored like any other key (hash + prefix) but with `is_test = 1` and no server
 * binding. Every endpoint answers such a key from memory after that one lookup, so it
 * can neither read real bans nor write anything. Revoke it with `/keys/:id/revoke`.
 */
adminRoutes.post('/test-keys', async (c) => {
  const body = asRecord(await readOptionalJson(c));
  const label = optionalString(body.label, 'label', 100);
  const scopes = parseScopes(body.scopes);
  const key = generateApiKey();
  const keyId = newId('key');
  const nowIso = new Date().toISOString();

  await c.env.DB.prepare(
    // api_keys 的 CHECK 要求 key 要么绑单服、要么绑 (owner, location) 组；
    // 测试 key 用哨兵组占位，is_test 会在任何组逻辑之前短路，所以它永远不被解释。
    `INSERT INTO api_keys (id, server_id, owner, location, prefix, key_hash, scopes, label, is_test, created_at)
     VALUES (?, NULL, 'sandbox', 'sandbox', ?, ?, ?, ?, 1, ?)`,
  )
    .bind(keyId, keyPrefix(key), await hashSecret(key), scopes.join(' '), label, nowIso)
    .run();

  await logAudit(c.env.DB, {
    actorType: 'admin',
    actorId: 'admin',
    action: 'key.issue',
    target: keyId,
    detail: { test: true, scopes, label },
  });

  return c.json(
    {
      id: keyId,
      key,
      prefix: keyPrefix(key),
      server_id: null,
      is_test: true,
      scopes,
      label,
      created_at: nowIso,
      warning:
        'Test key: validate-only. It never reads real bans and never writes. Store it now, it cannot be recovered.',
    },
    201,
  );
});

/** Test keys currently on the account, newest first. */
adminRoutes.get('/test-keys', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, prefix, scopes, label, created_at, revoked_at, last_used_at
       FROM api_keys WHERE is_test = 1 ORDER BY created_at DESC`,
  ).all();

  return c.json({ data: result.results ?? [] });
});

/** Emergency revocation: a maintainer can lift any server's ban. */
adminRoutes.post('/bans/:id/revoke', async (c) => {
  const id = c.req.param('id');
  const row = await loadBan(c.env.DB, id);
  if (!row) throw new ApiError(404, 'not_found', 'Ban not found.');

  const body = asRecord(await readOptionalJson(c));
  const reason = optionalString(body.reason, 'reason', 500);
  const nowIso = new Date().toISOString();

  if (row.status !== 'revoked') {
    await c.env.DB.prepare(
      `UPDATE bans SET status = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso, reason, nowIso, id)
      .run();
  }

  try {
    await refreshPlayer(c.env.DB, row.steam_id, nowIso);
  } catch (error) {
    console.error('player stats refresh failed', error);
  }

  await logAudit(c.env.DB, {
    actorType: 'admin',
    actorId: 'admin',
    action: 'ban.revoke',
    target: id,
    detail: { reason },
  });

  const updated = await loadBan(c.env.DB, id);
  const reports = await loadReports(c.env.DB, [row.steam_id]);

  return c.json({
    ban: updated
      ? {
          id: updated.id,
          status: updated.status,
          revoked_at: updated.revoked_at,
          revoke_reason: updated.revoke_reason,
          steam_id: updated.steam_id,
        }
      : null,
    reports: reports.get(row.steam_id) ?? emptyReports(row.steam_id, nowIso),
  });
});

/** Rebuild the whole player_stats read model from the ban records. */
adminRoutes.post('/reindex', async (c) => {
  const startedAt = new Date().toISOString();
  const players = await reindexAll(c.env.DB, startedAt);

  await logAudit(c.env.DB, {
    actorType: 'admin',
    actorId: 'admin',
    action: 'stats.reindex',
    detail: { players },
  });

  return c.json({ players, started_at: startedAt });
});

adminRoutes.get('/audit', async (c) => {
  const params = new URL(c.req.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 100) || 100, 1), 500);
  const action = params.get('action');

  const clauses: string[] = [];
  const bindings: Array<string | number> = [];

  if (action) {
    clauses.push('action = ?');
    bindings.push(action);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const result = await c.env.DB.prepare(
    `SELECT id, actor_type, actor_id, action, target, detail, created_at
       FROM audit_log ${where} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...bindings, limit)
    .all<{
      id: string;
      actor_type: string;
      actor_id: string;
      action: string;
      target: string | null;
      detail: string | null;
      created_at: string;
    }>();

  return c.json({
    data: (result.results ?? []).map((row) => ({
      ...row,
      detail: row.detail ? safeParse(row.detail) : null,
    })),
  });
});

adminRoutes.get('/players/:steamId', async (c) => {
  const steamId = parseSteamId(c.req.param('steamId'), 'steamId');
  const reports = await loadReports(c.env.DB, [steamId]);
  return c.json({ data: reports.get(steamId) ?? emptyReports(steamId, new Date().toISOString()) });
});

function requireString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_request', `${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ApiError(400, 'invalid_request', `${field} must be ${min}-${max} characters.`);
  }
  return trimmed;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_request', `${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ApiError(400, 'invalid_request', `${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

function parseServerStatus(value: unknown): 'active' | 'defederated' {
  if (value !== 'active' && value !== 'defederated') {
    throw new ApiError(400, 'invalid_request', 'status must be "active" or "defederated".');
  }
  return value;
}

function parseScopes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return ['bans:write', 'bans:read'];

  const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[\s,]+/);
  const scopes = [...new Set(list.map((scope) => scope.trim()).filter(Boolean))];

  if (scopes.length === 0) throw new ApiError(400, 'invalid_request', 'scopes must not be empty.');
  for (const scope of scopes) {
    if (scope !== 'bans:read' && scope !== 'bans:write' && scope !== '*') {
      throw new ApiError(400, 'invalid_scope', `Unknown scope "${scope}".`);
    }
  }
  return scopes;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'server';
}

async function allocateServerId(db: D1Database, base: string): Promise<string> {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const exists = await db.prepare('SELECT 1 AS x FROM servers WHERE id = ?').bind(candidate).first();
    if (!exists) return candidate;
  }
  throw new ApiError(409, 'conflict', 'Could not allocate a free server id.');
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
