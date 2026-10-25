export interface AuthContext {
  keyId: string;
  /** 单服 key 绑定的服务器；组 key 为 null（用 owner+location 解析） */
  serverId: string | null;
  serverName: string | null;
  /** 组 key 的管理方 / 地理位置；单服 key 为 null */
  owner: string | null;
  location: string | null;
  scopes: string[];
  /**
   * 测试 key：认证查询之后不再访问数据库，所有响应由 src/sandbox.ts 在内存里合成。
   */
  sandbox: boolean;
}

export interface Env {
  /**
   * Single private D1 database for this project (`wardogs_bans`).
   *
   * It holds the ban records, the member servers, the hashed API keys, the
   * per-SteamID aggregate (`player_stats`) and the audit log. This project is
   * deliberately separate from any existing anti-cheat database.
   */
  DB: D1Database;
  /** 用量守卫的共享 KV：halt:<service> 存在时本服务拒绝请求（Cloudflare 没有花钱刹车，自己拉） */
  GUARD?: KVNamespace;
  ADMIN_TOKEN?: string;
  ENVIRONMENT?: string;
  /**
   * Sandbox identity for test keys, resolved at runtime. JSON:
   * {"server":{"id":"…","name":"…"},"steam_id":"7656119…","ban":{…}}.
   * Unset means test keys answer 503 instead of inventing an identity.
   */
  SANDBOX?: string;
}

export type AppVariables = {
  requestId: string;
  auth: AuthContext;
};

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
