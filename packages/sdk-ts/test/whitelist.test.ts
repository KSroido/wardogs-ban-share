import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BanListClient, Whitelist } from '../src/index.js';
import type { Ban, PlayerReports } from '../src/index.js';

const BASE = 'https://bans.test';
const KEY = 'wdb_test_key_1234567890';
const WHITELISTED = '76561198000000001';
const OTHER = '76561198000000002';

function reports(steamId: string): PlayerReports {
  return {
    steam_id: steamId,
    server_count: 2,
    active_server_count: 1,
    ban_count: 2,
    active_ban_count: 1,
    permanent_count: 1,
    reason_counts: { cheat: 1 },
    first_reported_at: '2026-09-01T00:00:00.000Z',
    last_reported_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

function ban(steamId: string): Ban {
  return {
    id: 'ban_1',
    server: { id: 'demo', name: 'Demo Server' },
    steam_id: steamId,
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
    reports: reports(steamId),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 记录每一次 HTTP 调用；白名单用例要求它是 0。 */
function makeFetch(handler: (url: URL) => Response) {
  return vi.fn(async (input: RequestInfo | URL) => handler(new URL(String(input))));
}

function clientWith(whitelist: string[] | Set<string> | string, fetchImpl: unknown) {
  return new BanListClient({
    baseUrl: BASE,
    apiKey: KEY,
    whitelist,
    fetch: fetchImpl as typeof fetch,
    retries: 0,
  });
}

const tempDirs: string[] = [];

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wardogs-whitelist-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('whitelist short-circuit', () => {
  it('getPlayer returns a local whitelisted detail with zero HTTP calls', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}));
    const client = clientWith([WHITELISTED], fetchImpl);

    const player = await client.getPlayer(WHITELISTED);

    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(player.steam_id).toBe(WHITELISTED);
    expect(player.whitelisted).toBe(true);
    expect(player.bans).toEqual([]);
    expect(player.reports.server_count).toBe(0);
    expect(player.reports.ban_count).toBe(0);
    expect(player.reports.reason_counts).toEqual({});
    expect(player.reports.first_reported_at).toBeNull();
  });

  it('getPlayer still queries the API for players outside the whitelist', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({ steam_id: OTHER, reports: reports(OTHER), bans: [ban(OTHER)] }),
    );
    const client = clientWith([WHITELISTED], fetchImpl);

    const player = await client.getPlayer(OTHER);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(player.whitelisted).toBe(false);
    expect(player.bans).toHaveLength(1);
    expect(player.reports.server_count).toBe(2);
  });

  it('lookupSteamIds drops whitelisted ids from the request', async () => {
    let seen = '';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen = String(input);
      return jsonResponse({
        data: [ban(OTHER)],
        next_cursor: null,
        has_more: false,
        server_time: '2026-10-01T00:00:00.000Z',
      });
    });
    const client = clientWith([WHITELISTED], fetchImpl);

    const bans = await client.lookupSteamIds([WHITELISTED, OTHER]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL(seen).searchParams.get('steam_id')).toBe(OTHER);
    expect(bans.map((item) => item.steam_id)).toEqual([OTHER]);
  });

  it('lookupSteamIds makes no request when every id is whitelisted', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}));
    const client = clientWith([WHITELISTED, OTHER], fetchImpl);

    const bans = await client.lookupSteamIds([WHITELISTED, OTHER]);

    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(bans).toEqual([]);
  });

  it('listBans returns a local empty page when the whole steam_id filter is whitelisted', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}));
    const client = clientWith([WHITELISTED], fetchImpl);

    const page = await client.listBans({ steam_id: [WHITELISTED], status: 'all' });

    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(page.data).toEqual([]);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
  });

  it('listBans narrows a mixed steam_id filter to the non-whitelisted ids', async () => {
    let seen = '';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen = String(input);
      return jsonResponse({
        data: [],
        next_cursor: null,
        has_more: false,
        server_time: '2026-10-01T00:00:00.000Z',
      });
    });
    const client = clientWith([WHITELISTED], fetchImpl);

    await client.listBans({ steam_id: [WHITELISTED, OTHER] });

    const filter = new URL(seen).searchParams.get('steam_id');
    expect(filter).toBe(OTHER);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('iterateBans yields nothing and calls nothing for a whitelisted filter', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}));
    const client = clientWith([WHITELISTED], fetchImpl);

    const ids: string[] = [];
    for await (const item of client.iterateBans({ steam_id: [WHITELISTED], status: 'all' })) {
      ids.push(item.id);
    }

    expect(ids).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });
});

describe('partitionSteamIds', () => {
  it('splits, dedupes and keeps the original order', () => {
    const client = clientWith(new Set([WHITELISTED]), makeFetch(() => jsonResponse({})));

    const parts = client.partitionSteamIds([OTHER, WHITELISTED, OTHER, WHITELISTED]);

    expect(parts.whitelisted).toEqual([WHITELISTED]);
    expect(parts.others).toEqual([OTHER]);
  });

  it('treats an empty whitelist as "everything needs a query"', () => {
    const client = clientWith([], makeFetch(() => jsonResponse({})));

    const parts = client.partitionSteamIds([WHITELISTED, OTHER]);

    expect(parts.whitelisted).toEqual([]);
    expect(parts.others).toEqual([WHITELISTED, OTHER]);
  });
});

describe('whitelist sources', () => {
  it('accepts a JSON array file', async () => {
    const path = tempFile('wl.json', JSON.stringify([WHITELISTED]));
    const fetchImpl = makeFetch(() => jsonResponse({}));
    const client = clientWith(path, fetchImpl);

    expect(client.isWhitelisted(WHITELISTED)).toBe(true);
    expect(client.whitelistSize).toBe(1);

    await client.getPlayer(WHITELISTED);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('accepts a line-based file with comments and blank lines', () => {
    const path = tempFile('wl.txt', ['# 手工维护', '', WHITELISTED, '   ', '# 下一位', OTHER].join('\n'));

    const whitelist = new Whitelist(path);

    expect(whitelist.size).toBe(2);
    expect(whitelist.has(WHITELISTED)).toBe(true);
    expect(whitelist.has(OTHER)).toBe(true);
    expect(whitelist.filePath).toBe(path);
  });

  it('reloadWhitelist picks up edits without rebuilding the client', async () => {
    const path = tempFile('wl.txt', `${WHITELISTED}\n`);
    const fetchImpl = makeFetch(() => jsonResponse({}));
    const client = clientWith(path, fetchImpl);

    expect(client.isWhitelisted(OTHER)).toBe(false);

    writeFileSync(path, `${WHITELISTED}\n${OTHER}\n`, 'utf8');
    expect(client.reloadWhitelist()).toBe(true);
    expect(client.isWhitelisted(OTHER)).toBe(true);
    expect(client.whitelistSize).toBe(2);

    await client.getPlayer(OTHER);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('reloadWhitelist is a no-op for an in-memory list', () => {
    const client = clientWith([WHITELISTED], makeFetch(() => jsonResponse({})));

    expect(client.reloadWhitelist()).toBe(false);
    expect(client.isWhitelisted(WHITELISTED)).toBe(true);
  });

  it('setWhitelist replaces the in-memory list', () => {
    const client = clientWith([WHITELISTED], makeFetch(() => jsonResponse({})));

    client.setWhitelist([OTHER]);

    expect(client.isWhitelisted(WHITELISTED)).toBe(false);
    expect(client.isWhitelisted(OTHER)).toBe(true);
  });

  it('rejects JSON numbers in a flat array instead of truncating the SteamID64', () => {
    const path = tempFile('wl.json', '[76561198000000001]');

    expect(() => new Whitelist(path)).toThrow(/quoted string/);
  });

  it('rejects non-string entries in an in-memory list', () => {
    expect(() => new Whitelist([76561198000000001 as unknown as string])).toThrow(/strings/);
  });
});
