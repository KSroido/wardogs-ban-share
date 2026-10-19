import type { Context } from 'hono';
import type { AppEnv, AuthContext } from './env';
import { ApiError } from './errors';
import { hashSecret } from './crypto';

export type Scope = 'bans:read' | 'bans:write';

interface KeyRow {
  id: string;
  server_id: string;
  key_hash: string;
  scopes: string;
  revoked_at: string | null;
  last_used_at: string | null;
  server_name: string;
  server_status: string;
}

/**
 * Bearer key authentication.
 *
 * Keys are bound to exactly one server: the `server_id` in a request body is
 * ignored, and a key can never see or revoke another server's records.
 */
export async function requireApiKey(c: Context<AppEnv>): Promise<AuthContext> {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) {
    throw new ApiError(401, 'unauthorized', 'Missing Authorization: Bearer <key> header.');
  }

  const token = match[1]!;
  if (!token.startsWith('wdb_') || token.length < 20) {
    throw new ApiError(401, 'unauthorized', 'Malformed API key.');
  }

  // The prefix is only an index; the SHA-256 comparison is what authenticates.
  const rows = await c.env.DB.prepare(
    `SELECT k.id, k.server_id, k.key_hash, k.scopes, k.revoked_at, k.last_used_at,
            s.name AS server_name, s.status AS server_status
       FROM api_keys k
       JOIN servers s ON s.id = k.server_id
      WHERE k.prefix = ?`,
  )
    .bind(token.slice(4, 12))
    .all<KeyRow>();

  const digest = await hashSecret(token);
  const row = (rows.results ?? []).find((candidate) => candidate.key_hash === digest);

  if (!row) {
    throw new ApiError(401, 'unauthorized', 'Unknown API key.');
  }
  if (row.revoked_at) {
    throw new ApiError(401, 'key_revoked', 'This API key has been revoked.');
  }
  if (row.server_status !== 'active') {
    throw new ApiError(403, 'server_defederated', 'This server has been removed from the federation.');
  }

  touchKey(c, row);

  return {
    keyId: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    scopes: row.scopes.split(/\s+/).filter(Boolean),
  };
}

export function requireScope(auth: AuthContext, scope: Scope): void {
  if (!auth.scopes.includes(scope) && !auth.scopes.includes('*')) {
    throw new ApiError(403, 'forbidden', `This key is missing the "${scope}" scope.`);
  }
}

/** Constant-time-ish comparison via hashing, so length does not leak. */
export async function requireAdmin(c: Context<AppEnv>): Promise<void> {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected || expected.length < 24) {
    throw new ApiError(503, 'admin_disabled', 'ADMIN_TOKEN is not configured (min 24 characters).');
  }

  const header = c.req.header('x-admin-token') ?? /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (!header) {
    throw new ApiError(401, 'unauthorized', 'Missing X-Admin-Token header.');
  }

  const [expectedHash, providedHash] = await Promise.all([hashSecret(expected), hashSecret(header)]);
  if (expectedHash !== providedHash) {
    throw new ApiError(401, 'unauthorized', 'Invalid admin token.');
  }
}

/** Cheap write amplification guard: at most one UPDATE per key per hour. */
function touchKey(c: Context<AppEnv>, row: KeyRow): void {
  const now = Date.now();
  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (Number.isFinite(last) && now - last < 3_600_000) return;

  const statement = c.env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
    .bind(new Date(now).toISOString(), row.id)
    .run()
    .catch(() => undefined);

  try {
    c.executionCtx.waitUntil(statement);
  } catch {
    // No execution context (unit tests): fire and forget.
    void statement;
  }
}
