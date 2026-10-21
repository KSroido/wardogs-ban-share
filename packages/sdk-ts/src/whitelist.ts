/**
 * 本地白名单。
 *
 * 命中白名单的玩家在**发起任何 HTTP 请求之前**直接返回本地结果（见
 * `BanListClient.getPlayer` / `listBans` / `lookupSteamIds`）。白名单只是
 * 运营方自己的“免检名单”，服务端并不知道它的存在，所以本地结果里只标
 * `whitelisted: true`，不会伪造任何 ban 数据。
 *
 * 支持两种来源：
 *   - 内存列表 / Set：`new BanListClient({ whitelist: ['7656119...', ...] })`
 *   - 文件路径：`new BanListClient({ whitelist: './whitelist.txt' })`
 *
 * 文件格式二选一（自动识别）：
 *   - JSON 数组：`["76561198000000001", "76561198000000002"]`
 *   - 每行一个：空行忽略，`#` 开头的整行视为注释
 *
 * 文件只在构造和 `Whitelist.reload()` 时读一次；命中判断是纯内存操作。
 * 读文件用 Node 的同步 `fs`，通过 `process.getBuiltinModule` 惰性获取，
 * 因此不会给 Worker / 浏览器打包引入 `node:fs`。这些环境请直接传数组。
 */

/** 一批 SteamID64 的划分结果，字段名与其它语言 SDK 一致。 */
export interface SteamIdPartition {
  /** 命中本地白名单、无需查询的 SteamID64。 */
  whitelisted: string[];
  /** 仍需向服务端查询的 SteamID64。 */
  others: string[];
}

/**
 * 白名单输入。`string` 一律当作**文件路径**（单个 SteamID64 请包成数组）。
 */
export type WhitelistInput = Iterable<string> | string | null | undefined;

interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
}

/** 取出 Node 内置 fs；非 Node 运行时（或 Node < 22.3）返回 null。 */
function nodeFs(): NodeFs | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof proc?.getBuiltinModule !== 'function') return null;
  try {
    return proc.getBuiltinModule('node:fs') as NodeFs;
  } catch {
    return null;
  }
}

function readFileText(path: string): string {
  const fs = nodeFs();
  if (!fs) {
    throw new Error(
      `whitelist: cannot read "${path}" — file sources need Node's sync fs (Node >= 22.3, or any build exposing process.getBuiltinModule). Pass an array of SteamID64 instead.`,
    );
  }
  return fs.readFileSync(path, 'utf8');
}

/**
 * 解析白名单文件内容。首字符是 `[` 按 JSON 数组，否则按每行一个。
 *
 * JSON 数组里只接受字符串：17 位 SteamID64 超出 JS 安全整数范围，接受数字
 * 会静默截断成另一个 ID，所以这里宁可报错。
 */
export function parseWhitelistText(text: string): string[] {
  const body = text.replace(/^\uFEFF/, '').trim();
  if (body.length === 0) return [];
  return body.startsWith('[') ? parseJsonArray(body) : parseLineList(body);
}

function parseJsonArray(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`whitelist: invalid JSON array: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('whitelist: expected a JSON array of SteamID64 strings');
  }

  return parsed.map((entry: unknown, index: number) => {
    if (typeof entry !== 'string') {
      throw new Error(
        `whitelist: entry #${index} is not a string — write SteamID64 as a quoted string, JS numbers lose precision`,
      );
    }
    return entry.trim();
  });
}

function parseLineList(text: string): string[] {
  const ids: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    ids.push(line);
  }
  return ids;
}

/** 内存名单里的条目必须是字符串：17 位 SteamID64 不是安全整数。 */
function normalizeEntry(entry: unknown): string {
  if (typeof entry !== 'string') {
    throw new Error(
      'whitelist: entries must be SteamID64 strings — JS numbers lose precision above 2^53',
    );
  }
  return entry.trim();
}

/**
 * 一份不可变语义的白名单快照。构造时一次性读入，`reload()` 才会重新读文件。
 */
export class Whitelist {
  private ids = new Set<string>();
  private source: string | null = null;

  constructor(input?: WhitelistInput) {
    if (input === null || input === undefined) return;
    if (typeof input === 'string') {
      this.source = input;
      this.replace(parseWhitelistText(readFileText(input)));
      return;
    }
    this.replace(input);
  }

  /** 精确匹配（两侧空白会被忽略）。 */
  has(steamId: string): boolean {
    return this.ids.has(steamId.trim());
  }

  get size(): number {
    return this.ids.size;
  }

  /** 文件来源路径；内存列表为 null。 */
  get filePath(): string | null {
    return this.source;
  }

  /** 去重、保序地划分一批 SteamID64。空串会被丢掉。 */
  partition(steamIds: Iterable<string>): SteamIdPartition {
    const whitelisted: string[] = [];
    const others: string[] = [];
    const seen = new Set<string>();

    for (const raw of steamIds) {
      const id = String(raw).trim();
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      (this.ids.has(id) ? whitelisted : others).push(id);
    }

    return { whitelisted, others };
  }

  /** 用一批 SteamID64 替换内存名单（不会改动文件来源）。 */
  set(steamIds: Iterable<string>): void {
    this.replace(steamIds);
  }

  /** 重新读文件。没有文件来源（构造时传的是内存列表）返回 false。 */
  reload(): boolean {
    if (this.source === null) return false;
    this.replace(parseWhitelistText(readFileText(this.source)));
    return true;
  }

  private replace(entries: Iterable<string>): void {
    const next = new Set<string>();
    for (const entry of entries) {
      const id = normalizeEntry(entry);
      if (id.length > 0) next.add(id);
    }
    this.ids = next;
  }
}
