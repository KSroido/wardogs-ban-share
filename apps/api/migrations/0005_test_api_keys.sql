-- Test API keys.
--
-- A test key is stored exactly like a member key (SHA-256 hash plus an 8-character
-- prefix) so it can be issued and revoked from the same admin surface. The flag
-- changes what the Worker does after the lookup: every endpoint answers from
-- memory, so a test key can never read real bans or write to this database.
-- Authenticating the key is the only statement a test request runs.
ALTER TABLE api_keys ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
