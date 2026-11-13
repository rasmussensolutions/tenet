CREATE TABLE tenet_machine (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  enrollment_hash TEXT NOT NULL UNIQUE,
  enrollment_expires BIGINT NOT NULL,
  credential_hash TEXT UNIQUE,
  created_at BIGINT NOT NULL,
  enrolled_at BIGINT,
  last_seen BIGINT,
  revoked_at BIGINT,
  telemetry TEXT
);
CREATE INDEX tenet_machine_created ON tenet_machine (created_at);
