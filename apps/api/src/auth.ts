import type { Context } from 'hono';
import type { AppEnv, AuthContext } from './env';
import { ApiError } from './errors';
import { hashSecret } from './crypto';

export type Scope = 'bans:read' | 'bans:write';

interface KeyRow {
  id: string;
  /** 单服 key 才有；组 key 为 null */
  server_id: string | null;
  /** 组 key 的管理方 / 地理位置；单服 key 为 null */
  owner: string | null;
  location: string | null;
  key_hash: string;
  scopes: string;
  revoked_at: string | null;
  last_used_at: string | null;
  /** 测试 key：认证之后一切响应由 src/sandbox.ts 在内存里合成 */
  is_test: number;
  server_name: string | null;
  server_status: string | null;
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
    `SELECT k.id, k.server_id, k.owner, k.location, k.key_hash, k.scopes, k.revoked_at, k.last_used_at,
            k.is_test, s.name AS server_name, s.status AS server_status
       FROM api_keys k
       LEFT JOIN servers s ON s.id = k.server_id
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

  // 测试 key：查询到此行为止。既不碰服务器状态/组在册检查，也不写 last_used_at，
  // 后续响应全部由 src/sandbox.ts 在内存里合成（见各路由的 sandbox 分支）。
  if (row.is_test) {
    return {
      keyId: row.id,
      serverId: null,
      serverName: null,
      owner: null,
      location: null,
      scopes: row.scopes.split(/\s+/).filter(Boolean),
      sandbox: true,
    };
  }

  if (row.server_id) {
    if (row.server_status !== 'active') {
      throw new ApiError(403, 'server_defederated', 'This server has been removed from the federation.');
    }
  } else {
    // 组 key：组里至少还有一台 active 的服，否则等同于除名
    const active = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM servers WHERE owner = ? AND location = ? AND status = 'active'`,
    )
      .bind(row.owner, row.location)
      .first<{ n: number }>();
    if (!active || Number(active.n) === 0) {
      throw new ApiError(403, 'server_defederated', "No active server left in this key's group.");
    }
  }

  touchKey(c, row);

  return {
    keyId: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    owner: row.owner,
    location: row.location,
    scopes: row.scopes.split(/\s+/).filter(Boolean),
    sandbox: false,
  };
}

/**
 * 这条 ban 算哪台服的？
 *
 * - 单服 key：只能是它自己（请求里写了别的 server_id → 403）；
 * - 组 key：**必须**带 server_id，且必须是本组（owner+location）里的服。
 *   组里只有一台时也不猜 —— 以后加服不会让老客户端静默失效。
 */
export async function resolveWriteServer(
  db: D1Database,
  auth: AuthContext,
  requested: string | null | undefined,
): Promise<string> {
  const asked = requested ? String(requested).trim() : '';

  if (auth.serverId) {
    if (asked && asked !== auth.serverId) {
      throw new ApiError(403, 'forbidden', 'This key belongs to another server.');
    }
    return auth.serverId;
  }

  if (asked) {
    const row = await db
      .prepare(`SELECT status FROM servers WHERE id = ? AND owner = ? AND location = ?`)
      .bind(asked, auth.owner, auth.location)
      .first<{ status: string }>();
    if (!row) throw new ApiError(403, 'forbidden', 'server_id is not covered by this key.');
    if (row.status !== 'active') {
      throw new ApiError(409, 'server_defederated', 'That server has been removed from the federation.');
    }
    return asked;
  }

  // 组 key 一律要求显式 server_id：组里现在可能只有一台，但以后会加别人的服，
  // 让客户端「靠组里只有一台」隐式工作 = 将来静默 400。
  throw new ApiError(
    400,
    'server_id_required',
    'This key covers an (owner, location) group; set server_id in the request body.',
  );
}

/** 读/撤销：这台服归不归本 key 管（组 key 覆盖整组） */
export async function canTouchServer(db: D1Database, auth: AuthContext, serverId: string): Promise<boolean> {
  if (auth.serverId) return auth.serverId === serverId;
  const row = await db
    .prepare(`SELECT 1 AS x FROM servers WHERE id = ? AND owner = ? AND location = ?`)
    .bind(serverId, auth.owner, auth.location)
    .first();
  return Boolean(row);
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
