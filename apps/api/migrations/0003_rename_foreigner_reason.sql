-- Rename the 6th ban reason: `foreigner` → `foreignofserverlocation`
-- ("外籍服" — the player's account/region sits outside the servers' target region).
--
-- The CHECK constraint is baked into the table, so this is another rebuild (same pattern
-- as 0002). Existing rows are rewritten in the INSERT SELECT; at the time of writing the
-- table holds no such row, but the mapping keeps the migration safe on any other replica.

CREATE TABLE bans_new (
  id                TEXT PRIMARY KEY,
  server_id         TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  steam_id          TEXT NOT NULL CHECK (
                      length(steam_id) = 17
                      AND steam_id GLOB '7656119*'
                      AND steam_id NOT GLOB '*[^0-9]*'
                    ),
  player_name       TEXT,
  reason            TEXT NOT NULL CHECK (reason IN (
                      'cheat', 'rulebreak', 'chattroll', 'gametroll',
                      'racism', 'foreignofserverlocation', 'steamrisk', 'ownreason'
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

INSERT INTO bans_new (
  id, server_id, steam_id, player_name, reason, note, evidence_url,
  permanent, duration_days, expires_at, status, external_case_id,
  revoked_at, revoke_reason, created_at, updated_at
)
SELECT
  id, server_id, steam_id, player_name,
  CASE reason WHEN 'foreigner' THEN 'foreignofserverlocation' ELSE reason END,
  note, evidence_url, permanent, duration_days, expires_at, status, external_case_id,
  revoked_at, revoke_reason, created_at, updated_at
FROM bans;

DROP TABLE bans;
ALTER TABLE bans_new RENAME TO bans;

CREATE INDEX idx_bans_sync ON bans (updated_at, id);
CREATE INDEX idx_bans_steam ON bans (steam_id, status);
CREATE INDEX idx_bans_server ON bans (server_id, status);
CREATE UNIQUE INDEX idx_bans_external_case ON bans (server_id, external_case_id)
  WHERE external_case_id IS NOT NULL;
