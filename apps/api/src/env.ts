export interface AuthContext {
  keyId: string;
  serverId: string;
  serverName: string;
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
