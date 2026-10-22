/**
 * Test keys answer every endpoint from memory.
 *
 * The one database statement a test request may run is the `api_keys` lookup that
 * authenticates it. The fake DB below throws on any other statement, so these tests
 * fail loudly if a sandbox branch ever reaches for real data.
 */
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { hashSecret } from '../src/crypto';

const TOKEN = `wdb_${'T'.repeat(40)}`;

const SANDBOX = JSON.stringify({
  server: { id: 'sandbox', name: 'Sandbox Test Server' },
  steam_id: '76561198000000000',
  ban: {
    reason: 'cheat',
    permanent: true,
    player_name: 'sandbox_player',
    note: 'demo record',
    evidence_url: 'https://example.com/demo.png',
    external_case_id: 'demo-case-1',
    created_at: '2026-01-01T00:00:00.000Z',
  },
});

async function makeEnv(overrides: Record<string, unknown> = {}) {
  const keyHash = await hashSecret(TOKEN);
  const queries: string[] = [];

  const row = {
    id: 'key_test',
    server_id: null,
    owner: null,
    location: null,
    key_hash: keyHash,
    scopes: 'bans:read bans:write',
    revoked_at: null,
    last_used_at: null,
    is_test: 1,
    server_name: null,
    server_status: null,
  };

  const db = {
    prepare(sql: string) {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (!sql.includes('FROM api_keys')) {
        throw new Error(`sandbox path touched the database: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`);
      }

      const statement = {
        bind: () => statement,
        all: async () => ({ results: [row], success: true, meta: {} }),
        first: async () => null,
        run: async () => {
          throw new Error('sandbox path must not write');
        },
      };
      return statement;
    },
  };

  const env = { DB: db, SANDBOX, ADMIN_TOKEN: 'x'.repeat(32), ...overrides };
  return { env, queries };
}

async function call(env: unknown, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const response = await worker.fetch(
    new Request(`https://example.com/api/ban-share${path}`, init),
    env as never,
    ctx as never,
  );
  return response as Response;
}

/** workers-types declares Response.json() as unknown; the tests only read plain JSON. */
async function body<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

function submitBody(bans: unknown[]): RequestInit {
  return { method: 'POST', headers: authHeaders(), body: JSON.stringify({ bans }) };
}

describe('test keys', () => {
  it('accepts a valid ban with 200 and stores nothing', async () => {
    const { env, queries } = await makeEnv();

    const response = await call(
      env,
      '/v1/bans',
      submitBody([
        { steam_id: '76561198000000001', reason: 'cheat', permanent: true, external_case_id: 'case-1' },
      ]),
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.sandbox).toBe(true);
    expect(payload.created).toHaveLength(1);
    expect(payload.created[0].id.startsWith('sandbox_test_ban_')).toBe(true);
    expect(payload.errors).toEqual([]);

    // Exactly one statement, and it is the key lookup.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('FROM api_keys');
  });

  it('reports validation errors and still returns 200', async () => {
    const { env } = await makeEnv();

    const response = await call(
      env,
      '/v1/bans',
      submitBody([{ steam_id: '12345', reason: 'cheat', permanent: true }]),
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.created).toEqual([]);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].code).toBeTruthy();
  });

  it('reports a repeated SteamID inside one batch as a duplicate', async () => {
    const { env } = await makeEnv();
    const ban = { steam_id: '76561198000000002', reason: 'cheat', permanent: true };

    const response = await call(env, '/v1/bans', submitBody([ban, { ...ban }]));
    const payload = await body(response);

    expect(payload.created).toHaveLength(1);
    expect(payload.duplicates).toHaveLength(1);
    expect(payload.duplicates[0].index).toBe(1);
    expect(payload.duplicates[0].id).toBe(payload.created[0].id);
  });

  it('pulls exactly one demo record, never real data', async () => {
    const { env, queries } = await makeEnv();

    const response = await call(env, '/v1/bans?status=all&limit=500', { headers: authHeaders() });
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload.sandbox).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].server.id).toBe('sandbox');
    expect(payload.data[0].steam_id).toBe('76561198000000000');
    expect(payload.has_more).toBe(false);
    expect(queries).toHaveLength(1);
  });

  it('applies filters to the demo record', async () => {
    const { env } = await makeEnv();

    const other = await body(
      await call(env, '/v1/bans?status=all&steam_id=76561198000000099', { headers: authHeaders() }),
    );
    expect(other.data).toEqual([]);

    const revokedOnly = await body(
      await call(env, '/v1/bans?status=revoked', { headers: authHeaders() }),
    );
    expect(revokedOnly.data).toEqual([]);

    const hit = await body(
      await call(env, '/v1/bans?status=active&reason=cheat&server=sandbox', { headers: authHeaders() }),
    );
    expect(hit.data).toHaveLength(1);
  });

  it('shows only the sandbox server in the roster', async () => {
    const { env, queries } = await makeEnv();

    const payload = await body(await call(env, '/v1/servers', { headers: authHeaders() }));

    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].id).toBe('sandbox');
    expect(queries).toHaveLength(1);
  });

  it('answers player lookups from memory', async () => {
    const { env } = await makeEnv();

    const mine = await body(
      await call(env, '/v1/players/76561198000000000', { headers: authHeaders() }),
    );
    expect(mine.reports.server_count).toBe(1);
    expect(mine.bans).toHaveLength(1);

    const stranger = await body(
      await call(env, '/v1/players/76561198000000099', { headers: authHeaders() }),
    );
    expect(stranger.reports.server_count).toBe(0);
    expect(stranger.bans).toEqual([]);

    const board = await body(
      await call(env, '/v1/players?sort=servers', { headers: authHeaders() }),
    );
    expect(board.total).toBe(1);
    expect(board.data).toHaveLength(1);
  });

  it('revokes only the demo record', async () => {
    const { env } = await makeEnv();

    const ok = await call(env, '/v1/bans/sandbox_demo_ban/revoke', {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });
    expect(ok.status).toBe(200);
    expect((await body(ok)).status).toBe('revoked');

    const missing = await call(env, '/v1/bans/ban_something_else/revoke', {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });
    expect(missing.status).toBe(404);
    expect((await body(missing)).error.code).toBe('not_found');
  });

  it('refuses to invent an identity when SANDBOX is unset', async () => {
    const { env } = await makeEnv({ SANDBOX: undefined });

    const response = await call(env, '/v1/bans', { headers: authHeaders() });
    expect(response.status).toBe(503);
    expect((await body(response)).error.code).toBe('sandbox_unconfigured');
  });
});
