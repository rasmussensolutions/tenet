ALTER TABLE tenet_machine ADD COLUMN updater_key TEXT;
ALTER TABLE tenet_machine ADD COLUMN updater_seen BIGINT;
CREATE TABLE tenet_release (id INTEGER PRIMARY KEY CHECK (id = 1), envelope TEXT, checked_at BIGINT NOT NULL, next_check BIGINT NOT NULL, error TEXT);
INSERT INTO tenet_release (id, checked_at, next_check) VALUES (1, 0, 0);
CREATE TABLE tenet_update (
 id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES tenet_machine(id),
 envelope TEXT NOT NULL, version TEXT NOT NULL, build_id TEXT NOT NULL,
 status TEXT NOT NULL, error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX tenet_update_active ON tenet_update(machine_id) WHERE status IN ('queued','downloading','installing');
CREATE INDEX tenet_update_machine ON tenet_update(machine_id, created_at);
