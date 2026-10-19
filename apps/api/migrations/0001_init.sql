-- Wardogs federated ban list - initial schema (single D1 instance, several tables)

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Member servers. Created by a maintainer only after the onboarding issue is
-- approved. A server's `id` is a stable slug; `name` is the display name.
-- ---------------------------------------------------------------------------
CREATE TABLE servers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'defederated')),
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_servers_name ON servers (name);

-- ---------------------------------------------------------------------------
-- API keys. Only SHA-256(key) is stored; `prefix` is an index so auth is a
-- lookup instead of a table scan. A key is bound to exactly one server, which
-- is how the API knows who is uploading without trusting a body field.
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  server_id     TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  prefix        TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  scopes        TEXT NOT NULL DEFAULT 'bans:write',
  label         TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);

CREATE INDEX idx_api_keys_prefix ON api_keys (prefix);
CREATE INDEX idx_api_keys_server ON api_keys (server_id);

-- ---------------------------------------------------------------------------
-- Ban records: the source of truth.
-- ---------------------------------------------------------------------------
CREATE TABLE bans (
  id                TEXT PRIMARY KEY,
  server_id         TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  steam_id          TEXT NOT NULL CHECK (steam_id GLOB '7656119[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  player_name       TEXT,
  reason            TEXT NOT NULL CHECK (reason IN (
                      'cheat', 'rulebreak', 'chattroll', 'gametroll',
                      'racism', 'foreigner', 'steamrisk', 'ownreason'
                    )),
  note              TEXT,
  evidence_url      TEXT,
  permanent         INTEGER NOT NULL CHECK (permanent IN (0, 1)),
  duration_days     INTEGER,
  expires_at        TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  external_case_id  TEXT,
  revoked_at        TEXT,
  revoke_reason     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (
    (permanent = 1 AND duration_days IS NULL AND expires_at IS NULL)
    OR
    (permanent = 0 AND duration_days IS NOT NULL AND duration_days > 0 AND expires_at IS NOT NULL)
  )
);

-- Delta sync walks this index in (updated_at, id) order.
CREATE INDEX idx_bans_sync ON bans (updated_at, id);
CREATE INDEX idx_bans_steam ON bans (steam_id, status);
CREATE INDEX idx_bans_server ON bans (server_id, status);
-- Retrying a submission with the same case id must not create a second row.
CREATE UNIQUE INDEX idx_bans_external_case ON bans (server_id, external_case_id)
  WHERE external_case_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Read model: one row per SteamID that has at least one non-revoked ban.
-- Rebuildable from `bans` at any time (POST /admin/reindex, nightly cron).
-- `server_count` is the "how many servers reported this player" column.
-- ---------------------------------------------------------------------------
CREATE TABLE player_stats (
  steam_id             TEXT PRIMARY KEY,
  server_count         INTEGER NOT NULL DEFAULT 0,
  active_server_count  INTEGER NOT NULL DEFAULT 0,
  ban_count            INTEGER NOT NULL DEFAULT 0,
  active_ban_count     INTEGER NOT NULL DEFAULT 0,
  permanent_count      INTEGER NOT NULL DEFAULT 0,
  -- JSON object, only reasons with a non-zero count, e.g. {"cheat":3}
  reason_counts        TEXT NOT NULL DEFAULT '{}',
  first_reported_at    TEXT,
  last_reported_at     TEXT,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_player_stats_server_count ON player_stats (server_count DESC, steam_id);
CREATE INDEX idx_player_stats_active_servers ON player_stats (active_server_count DESC, steam_id);
CREATE INDEX idx_player_stats_last_reported ON player_stats (last_reported_at DESC, steam_id);

-- ---------------------------------------------------------------------------
-- Audit trail for every write, including key issuance and emergency removals.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('server', 'admin')),
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_audit_created ON audit_log (created_at);
CREATE INDEX idx_audit_action ON audit_log (action, created_at);
