BEGIN;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_type TEXT NOT NULL DEFAULT 'discussion';
DO $$ BEGIN
  ALTER TABLE posts ADD CONSTRAINT posts_post_type_check CHECK (post_type IN ('discussion','question'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS agent_action_tokens (
  token_hash TEXT PRIMARY KEY,
  action_family TEXT NOT NULL CHECK (action_family IN ('community','publish','relay')),
  client_hash TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  request_hash TEXT,
  status_code SMALLINT,
  result_json JSONB
);
CREATE INDEX IF NOT EXISTS agent_action_tokens_expires_idx ON agent_action_tokens(expires_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  status_code SMALLINT,
  result_json JSONB,
  PRIMARY KEY(scope, client_hash, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idempotency_records_expires_idx ON idempotency_records(expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY(bucket_key, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_idx ON rate_limit_buckets(window_start);

CREATE TABLE IF NOT EXISTS machine_activity (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  destination_host TEXT,
  method TEXT,
  status SMALLINT,
  duration_ms INTEGER,
  request_bytes INTEGER,
  response_bytes INTEGER,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS machine_activity_created_idx ON machine_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS machine_activity_action_idx ON machine_activity(action, created_at DESC);

CREATE TABLE IF NOT EXISTS published_items (
  id TEXT PRIMARY KEY,
  publisher TEXT NOT NULL CHECK (char_length(publisher) BETWEEN 1 AND 100),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 12000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  client_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS published_items_expires_idx ON published_items(expires_at);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentsite_runtime') THEN
    GRANT SELECT, INSERT ON posts TO agentsite_runtime;
    GRANT USAGE, SELECT ON SEQUENCE posts_id_seq TO agentsite_runtime;
    GRANT SELECT, UPDATE ON site_stats TO agentsite_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_action_tokens TO agentsite_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_records TO agentsite_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_buckets TO agentsite_runtime;
    GRANT SELECT, INSERT, DELETE ON machine_activity TO agentsite_runtime;
    GRANT USAGE, SELECT ON SEQUENCE machine_activity_id_seq TO agentsite_runtime;
    GRANT SELECT, INSERT, DELETE ON published_items TO agentsite_runtime;
  END IF;
END $$;

COMMIT;
