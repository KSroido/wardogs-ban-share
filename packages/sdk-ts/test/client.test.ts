import { describe, expect, it, vi } from 'vitest';
import { BanListClient, BanListError } from '../src/index.js';
import type { Ban, PlayerReports, SubmitBanInput } from '../src/index.js';

const BASE = 'https://bans.test';
const KEY = 'wdb_test_key_1234567890';

function reports(overrides: Partial<PlayerReports> = {}): PlayerReports {
  return {
    steam_id: '76561198000000001',
    server_count: 2,
    active_server_count: 1,
    ban_count: 2,
    active_ban_count: 1,
    permanent_count: 1,
    reason_counts: { cheat: 1, chattroll: 1 },
    first_reported_at: '2026-09-01T00:00:00.000Z',
    last_reported_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function ban(overrides: Partial<Ban> = {}): Ban {
  return {
    id: 'ban_1',
    server: { id: 'demo', name: 'Demo Server' },
    steam_id: '76561198000000001',
    player_name: null,
    reason: 'cheat',
    note: null,
    evidence_url: null,
    permanent: true,
    duration_days: null,
    expires_at: null,
    status: 'active',
    external_case_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    revoked_at: null,
    revoke_reason: null,
    reports: reports(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeClient(fetchImpl: typeof fetch) {
  return new BanListClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchImpl, retries: 0 });
}

describe('submitBan', () => {
  it('posts the ban with a bearer token and returns the stored record', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ created: [ban()], duplicates: [], errors: [] }, 201);
    }) as unknown as typeof fetch;

    const input: SubmitBanInput = {
      steam_id: '76561198000000001',
      reason: 'cheat',
      permanent: true,
      external_case_id: 'case-42',
    };

    const created = await makeClient(fetchImpl).submitBan(input);

    expect(created.id).toBe('ban_1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/bans`);
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ bans: [input] });
  });

  it('turns a duplicate into a BanListError with code duplicate_ban', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          created: [],
          duplicates: [{ index: 0, id: 'ban_9', steam_id: '76561198000000001', reason: 'cheat', status: 'active' }],
          errors: [],
        },
        200,
      ),
    ) as unknown as typeof fetch;

    const error = await makeClient(fetchImpl)
      .submitBan({ steam_id: '76561198000000001', reason: 'cheat', permanent: true })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BanListError);
    expect((error as BanListError).code).toBe('duplicate_ban');
    expect((error as BanListError).status).toBe(409);
  });

  it('chunks large batches into requests of 100', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ created: [], duplicates: [], errors: [] }, 200)) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    const input = (n: number): SubmitBanInput => ({ steam_id: `7656119${String(n).padStart(10, '0')}`, reason: 'rulebreak', permanent: true });
    await client.submitBans(Array.from({ length: 205 }, (_, i) => input(i + 1)));

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('listBans', () => {
  it('serializes array filters as comma separated values and clamps the page size', async () => {
    let seen = '';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen = String(input);
      return jsonResponse({ data: [], next_cursor: null, has_more: false, server_time: '2026-10-01T00:00:00.000Z' });
    }) as unknown as typeof fetch;

    await makeClient(fetchImpl).listBans({
      reason: ['cheat', 'racism'],
      steam_id: ['76561198000000001', '76561198000000002'],
      status: 'active',
      limit: 9999,
    });

    const url = new URL(seen);
    expect(url.pathname).toBe('/v1/bans');
    expect(url.searchParams.get('reason')).toBe('cheat,racism');
    expect(url.searchParams.get('steam_id')).toBe('76561198000000001,76561198000000002');
    expect(url.searchParams.get('limit')).toBe('500');
  });

  it('follows next_cursor until has_more is false', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.search);
      const cursor = url.searchParams.get('cursor');
      if (!cursor) {
        return jsonResponse({
          data: [ban({ id: 'ban_1' })],
          next_cursor: 'cursor-2',
          has_more: true,
          server_time: '2026-10-01T00:00:00.000Z',
        });
      }
      return jsonResponse({
        data: [ban({ id: 'ban_2' })],
        next_cursor: null,
        has_more: false,
        server_time: '2026-10-01T00:00:00.000Z',
      });
    }) as unknown as typeof fetch;

    const ids: string[] = [];
    for await (const item of makeClient(fetchImpl).iterateBans({ status: 'all' })) {
      ids.push(item.id);
    }

    expect(ids).toEqual(['ban_1', 'ban_2']);
    expect(urls[1]).toContain('cursor=cursor-2');
  });
});

describe('errors and retries', () => {
  it('surfaces the error envelope and request id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'forbidden', message: 'Key is not allowed to revoke this ban.' }, request_id: 'req_123' },
        403,
        { 'x-request-id': 'req_123' },
      ),
    ) as unknown as typeof fetch;

    const error = await makeClient(fetchImpl)
      .revokeBan('ban_1')
      .catch((err: unknown) => err);

    expect((error as BanListError).code).toBe('forbidden');
    expect((error as BanListError).requestId).toBe('req_123');
    expect((error as BanListError).isAuthError).toBe(true);
  });

  it('retries retryable status codes before giving up', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ error: { code: 'internal', message: 'boom' } }, 503);
      return jsonResponse({ data: [], next_cursor: null, has_more: false, server_time: '2026-10-01T00:00:00.000Z' });
    }) as unknown as typeof fetch;

    const client = new BanListClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchImpl, retries: 2 });
    const page = await client.listBans();

    expect(attempts).toBe(2);
    expect(page.data).toEqual([]);
  });
});
