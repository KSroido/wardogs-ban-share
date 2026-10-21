export interface AuthContext {
  keyId: string;
  /** 单服 key 绑定的服务器；组 key 为 null（用 owner+location 解析） */
  serverId: string | null;
  serverName: string | null;
  /** 组 key 的管理方 / 地理位置；单服 key 为 null */
  owner: string | null;
  location: string | null;
  scopes: string[];
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
  ADMIN_TOKEN?: string;
  ENVIRONMENT?: string;
}

export type AppVariables = {
  requestId: string;
  auth: AuthContext;
};

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
