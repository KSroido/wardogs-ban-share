import { BanListError } from './errors.js';
import { Whitelist } from './whitelist.js';
import type { SteamIdPartition, WhitelistInput } from './whitelist.js';
import type {
  Ban,
  ErrorEnvelope,
  HealthResult,
  ListBansQuery,
  ListBansResult,
  ListPlayersQuery,
  ListPlayersResult,
  ListServersResult,
  ListStatus,
  PlayerDetail,
  PlayerReports,
  Server,
  SubmitBanDuplicate,
  SubmitBanError,
  SubmitBanInput,
  SubmitBansResult,
} from './types.js';

type HttpMethod = 'GET' | 'POST';

export interface BanListClientOptions {
  /** API root, e.g. `https://bans.wardogs.example`. No trailing `/v1`. */
  baseUrl: string;
  /** Server key issued by the federation maintainers (`wdb_...`). */
  apiKey: string;
  /** Override for runtimes with a non-global fetch. */
  fetch?: typeof fetch;
  /** Per-attempt timeout. Default 15000 ms. */
  timeoutMs?: number;
  /** Retries for 429/5xx/network errors. Default 2. */
  retries?: number;
  /** Sent as User-Agent so the maintainers can see which SDKs are in use. */
  userAgent?: string;
  /**
   * 本地白名单：数组 / Set，或文件路径（JSON 数组或每行一个，`#` 开头为注释）。
   * 命中白名单的玩家在发请求前直接返回本地结果，详见 `Whitelist`。
   */
  whitelist?: WhitelistInput;
}

interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
}

const MAX_SUBMIT_BATCH = 100;
const MAX_STEAM_ID_LOOKUP = 50;
const MAX_PAGE_SIZE = 500;

export class BanListClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly userAgent: string;
  /** 本地白名单：命中者在发请求前直接返回本地结果。 */
  private readonly whitelist: Whitelist;

  constructor(options: BanListClientOptions) {
    if (!options || typeof options.baseUrl !== 'string' || options.baseUrl.length === 0) {
      throw new Error('BanListClient: baseUrl is required');
    }
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
      throw new Error('BanListClient: apiKey is required');
    }

    const fetchFn = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchFn !== 'function') {
      throw new Error('BanListClient: no fetch implementation available, pass options.fetch');
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchFn = fetchFn;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = Math.max(0, options.retries ?? 2);
    this.userAgent = options.userAgent ?? 'wardogs-banlist-ts/0.1.0';
    this.whitelist = new Whitelist(options.whitelist);
  }

  // ------------------------------------------------------------- whitelist

  /** 是否命中本地白名单。纯内存判断，不发请求。 */
  isWhitelisted(steamId: string): boolean {
    return this.whitelist.has(steamId);
  }

  /** 白名单条目数，便于确认 `reloadWhitelist()` 是否生效。 */
  get whitelistSize(): number {
    return this.whitelist.size;
  }

  /** 去重、保序地划分一批 SteamID64：命中白名单的 / 仍需查询的。 */
  partitionSteamIds(steamIds: Iterable<string>): SteamIdPartition {
    return this.whitelist.partition(steamIds);
  }

  /** 热加载：重新读取构造时传入的白名单文件。内存列表返回 false。 */
  reloadWhitelist(): boolean {
    return this.whitelist.reload();
  }

  /** 热替换内存白名单（不影响文件来源，之后仍可再 `reloadWhitelist()`）。 */
  setWhitelist(steamIds: Iterable<string>): void {
    this.whitelist.set(steamIds);
  }

  // ---------------------------------------------------------------- writes

  /**
   * Submit up to 100 bans in one request. Larger arrays are chunked
   * automatically and the per-chunk results are merged.
   */
  async submitBans(bans: SubmitBanInput[]): Promise<SubmitBansResult> {
    if (!Array.isArray(bans) || bans.length === 0) {
      throw new Error('submitBans: at least one ban is required');
    }

    const merged: SubmitBansResult = { created: [], duplicates: [], errors: [] };

    for (let offset = 0; offset < bans.length; offset += MAX_SUBMIT_BATCH) {
      const chunk = bans.slice(offset, offset + MAX_SUBMIT_BATCH);
      const result = await this.request<SubmitBansResult>('POST', '/v1/bans', {
        body: { bans: chunk },
      });
      merged.created.push(...result.created);
      merged.duplicates.push(
        ...result.duplicates.map((item: SubmitBanDuplicate) => ({
          ...item,
          index: item.index + offset,
        })),
      );
      merged.errors.push(
        ...result.errors.map((item: SubmitBanError) => ({
          ...item,
          index: item.index + offset,
        })),
      );
    }

    return merged;
  }

  /**
   * Submit exactly one ban and return the stored record.
   *
   * Throws a `BanListError` with code `duplicate_ban` when the server already
   * has an active ban for that player, or `invalid_request` when the record
   * was rejected. Use `submitBans` if you would rather inspect the result.
   */
  async submitBan(input: SubmitBanInput): Promise<Ban> {
    const result = await this.submitBans([input]);
    const created = result.created[0];
    if (created) return created;

    const duplicate = result.duplicates[0];
    if (duplicate) {
      throw new BanListError({
        status: 409,
        code: 'duplicate_ban',
        message: `An active ban for ${duplicate.steam_id} already exists (${duplicate.id}).`,
        details: duplicate,
      });
    }

    const failure = result.errors[0];
    throw new BanListError({
      status: 422,
      code: failure?.code ?? 'invalid_request',
      message: failure?.message ?? 'The ban was rejected.',
      details: failure,
    });
  }

  /** Lift a ban. Only the server that issued it (or a maintainer) may do this. */
  async revokeBan(banId: string, reason?: string): Promise<Ban> {
    return this.request<Ban>('POST', `/v1/bans/${encodeURIComponent(banId)}/revoke`, {
      body: reason ? { reason } : {},
    });
  }

  // ----------------------------------------------------------------- reads

  async listBans(query: ListBansQuery = {}): Promise<ListBansResult> {
    const limit = query.limit ?? 100;
    const filtered = this.filterWhitelistedIds(query.steam_id);
    if (filtered === null) return emptyBansPage();

    return this.request<ListBansResult>('GET', '/v1/bans', {
      query: {
        ...query,
        steam_id: filtered,
        limit: Math.min(Math.max(1, limit), MAX_PAGE_SIZE),
      },
    });
  }

  /**
   * 从 `steam_id` 过滤条件里剔除白名单玩家。
   *
   * 返回 `null` 表示“整批都命中白名单”——调用方直接返回本地空页，不发请求
   * （不能把空数组拼进查询串，否则服务端会当成“不过滤”返回全部记录）。
   */
  private filterWhitelistedIds(
    value: string | string[] | undefined,
  ): string | string[] | undefined | null {
    if (value === undefined) return undefined;

    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) return value;

    const { others } = this.whitelist.partition(list);
    if (others.length === 0) return null;
    if (!Array.isArray(value)) return others[0];
    return others.length === list.length ? value : others;
  }

  /**
   * Walk every matching ban page by page.
   *
   * For incremental sync pass `since` once and persist the last `updated_at`
   * you saw; pass `status: 'all'` so revocations are included.
   */
  async *iterateBans(query: ListBansQuery = {}): AsyncGenerator<Ban, void, undefined> {
    let cursor: string | undefined = query.cursor;
    for (;;) {
      const page = await this.listBans({ ...query, cursor });
      for (const ban of page.data) yield ban;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /** Look up active bans for specific players. Chunks into 50 per request. */
  async lookupSteamIds(steamIds: string[]): Promise<Ban[]> {
    // 白名单玩家不参与查询：整批命中时一次 HTTP 都不会发生。
    const { others: unique } = this.whitelist.partition(steamIds);
    const found: Ban[] = [];

    for (let offset = 0; offset < unique.length; offset += MAX_STEAM_ID_LOOKUP) {
      const chunk = unique.slice(offset, offset + MAX_STEAM_ID_LOOKUP);
      for await (const ban of this.iterateBans({ steam_id: chunk, status: 'active' })) {
        found.push(ban);
      }
    }

    return found;
  }

  /**
   * Everything known about one player: the cross-server report aggregate plus
   * every ban record. This is the call an admin panel makes before kicking.
   */
  async getPlayer(
    steamId: string,
    query: { status?: ListStatus; limit?: number } = {},
  ): Promise<PlayerDetail> {
    if (!/^7656119\d{10}$/.test(steamId)) {
      throw new Error(`getPlayer: "${steamId}" is not a SteamID64`);
    }

    // 命中白名单：本地结果，0 次 HTTP。不伪造 ban，只标 whitelisted。
    if (this.whitelist.has(steamId)) {
      return whitelistedPlayerDetail(steamId);
    }

    const detail = await this.request<Omit<PlayerDetail, 'whitelisted'> & { whitelisted?: boolean }>(
      'GET',
      `/v1/players/${encodeURIComponent(steamId)}`,
      { query: { status: query.status ?? 'active', limit: query.limit ?? 200 } },
    );
    return { ...detail, whitelisted: detail.whitelisted ?? false };
  }

  /** Players ranked by how many servers reported them (read model only). */
  async listPlayers(query: ListPlayersQuery = {}): Promise<ListPlayersResult> {
    return this.request<ListPlayersResult>('GET', '/v1/players', {
      query: { sort: query.sort ?? 'servers', limit: query.limit ?? 50, offset: query.offset ?? 0 },
    });
  }

  async listServers(): Promise<Server[]> {
    const result = await this.request<ListServersResult>('GET', '/v1/servers');
    return result.data;
  }

  async health(): Promise<HealthResult> {
    return this.request<HealthResult>('GET', '/health');
  }

  // ------------------------------------------------------------- internals

  private async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    let url: URL;
    try {
      url = new URL(this.baseUrl + path);
    } catch {
      throw new Error(`BanListClient: invalid baseUrl "${this.baseUrl}"`);
    }

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          if (value.length === 0) continue;
          url.searchParams.set(key, value.join(','));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      'user-agent': this.userAgent,
    };

    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchFn(url.toString(), {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        const text = await response.text();
        const payload = parseJson(text);

        if (response.ok) {
          return payload as T;
        }

        const canRetry = response.status === 429 || response.status >= 500;
        if (canRetry && attempt < this.retries) {
          await sleep(retryDelayMs(response, attempt));
          continue;
        }

        throw errorFromResponse(response, payload);
      } catch (error) {
        if (error instanceof BanListError) throw error;

        lastError = error;
        if (attempt < this.retries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw new BanListError({
      status: 0,
      code: 'network_error',
      message: `Request to ${url.pathname} failed: ${describeError(lastError)}`,
      details: lastError,
    });
  }
}

/**
 * 白名单玩家的本地详情：`whitelisted: true`，reports 全零，`bans` 为空数组。
 * 这些数字是“本地未做任何查询”的占位，不是服务端数据。
 */
function whitelistedPlayerDetail(steamId: string): PlayerDetail {
  return {
    steam_id: steamId,
    whitelisted: true,
    reports: {
      steam_id: steamId,
      server_count: 0,
      active_server_count: 0,
      ban_count: 0,
      active_ban_count: 0,
      permanent_count: 0,
      reason_counts: {},
      first_reported_at: null,
      last_reported_at: null,
      // 本地时钟，非服务端时间
      updated_at: new Date().toISOString(),
    } satisfies PlayerReports,
    bans: [],
  };
}

/** 整批过滤条件都命中白名单时返回的本地空页（`server_time` 为本地时钟）。 */
function emptyBansPage(): ListBansResult {
  return {
    data: [],
    next_cursor: null,
    has_more: false,
    server_time: new Date().toISOString(),
  };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorFromResponse(response: Response, payload: unknown): BanListError {
  const envelope = payload as Partial<ErrorEnvelope> | null;
  const code = envelope?.error?.code ?? fallbackCode(response.status);
  const message = envelope?.error?.message ?? `Request failed with HTTP ${response.status}`;

  return new BanListError({
    status: response.status,
    code,
    message,
    details: envelope?.error?.details,
    requestId: envelope?.request_id ?? response.headers.get('x-request-id') ?? undefined,
  });
}

function fallbackCode(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal';
  return 'invalid_request';
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'request timed out';
    return error.message;
  }
  return String(error);
}
