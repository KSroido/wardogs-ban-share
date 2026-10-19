import { BanListError } from './errors.js';
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
    return this.request<ListBansResult>('GET', '/v1/bans', {
      query: {
        ...query,
        limit: Math.min(Math.max(1, limit), MAX_PAGE_SIZE),
      },
    });
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
    const unique = [...new Set(steamIds)];
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
    return this.request<PlayerDetail>('GET', `/v1/players/${encodeURIComponent(steamId)}`, {
      query: { status: query.status ?? 'active', limit: query.limit ?? 200 },
    });
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
