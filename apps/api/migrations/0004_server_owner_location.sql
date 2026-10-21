-- Member servers gain an owner (管理方) and a geographic location.
--
-- Why: on onboarding the applicant must state where the server sits, and one key is issued
-- per (owner, location) pair so several servers of the same admin in the same place share a
-- token. Ban records then carry server.location so a reader can tell a ban filed by a server
-- in another region apart from a local one (this is what the `foreignofserverlocation`
-- reason is about).
--
-- api_keys therefore becomes either
--   * a single-server key  → server_id NOT NULL, owner/location NULL (pre-existing behaviour), or
--   * a group key          → server_id NULL, owner + location set, covering every server with
--                            that (owner, location); the submitter names the server in `server_id`.
-- SQLite can't relax NOT NULL in place, so api_keys is rebuilt (same pattern as 0002/0003).

ALTER TABLE servers ADD COLUMN owner TEXT;
ALTER TABLE servers ADD COLUMN location TEXT;

-- Backfill: existing servers belong to themselves, and their region was CN-only until now.
UPDATE servers SET owner = id WHERE owner IS NULL;
UPDATE servers SET location = 'cn' WHERE location IS NULL;
-- 历史值统一成 parseLocation 的归一化形式（小写、空格→短横线），否则「同位置」匹配不到
UPDATE servers SET location = lower(replace(location, ' ', '-')) WHERE location IS NOT NULL;

CREATE INDEX idx_servers_group ON servers (owner, location);

CREATE TABLE api_keys_new (
  id            TEXT PRIMARY KEY,
  -- 单服 key：绑死一台服
  server_id     TEXT REFERENCES servers (id) ON DELETE CASCADE,
  -- 组 key：管理方 + 地理位置，覆盖该组下所有服
  owner         TEXT,
  location      TEXT,
  prefix        TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  scopes        TEXT NOT NULL DEFAULT 'bans:write',
  label         TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT,
  CHECK (server_id IS NOT NULL OR (owner IS NOT NULL AND location IS NOT NULL))
);

INSERT INTO api_keys_new (id, server_id, owner, location, prefix, key_hash, scopes, label, created_at, last_used_at, revoked_at)
SELECT id, server_id, NULL, NULL, prefix, key_hash, scopes, label, created_at, last_used_at, revoked_at
FROM api_keys;

DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;

CREATE INDEX idx_api_keys_prefix ON api_keys (prefix);
CREATE INDEX idx_api_keys_server ON api_keys (server_id);
CREATE INDEX idx_api_keys_group ON api_keys (owner, location);
