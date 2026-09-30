import type Database from 'better-sqlite3';

export function ensureLifecycleSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS requirement_lifecycle_roots (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, requirement_id TEXT NOT NULL UNIQUE,
      current_version INTEGER NOT NULL, current_updated_at TEXT NOT NULL, payload TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, historical INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requirement_lifecycle_versions (
      requirement_id TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL,
      payload TEXT NOT NULL, archived INTEGER NOT NULL, recorded_at TEXT,
      PRIMARY KEY(requirement_id, version)
    );
    CREATE TABLE IF NOT EXISTS requirement_lifecycle_stamps (
      requirement_id TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL,
      PRIMARY KEY(requirement_id,updated_at,version)
    );
    CREATE TABLE IF NOT EXISTS requirement_lifecycle_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, requirement_id TEXT NOT NULL,
      event_key TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL,
      refs TEXT NOT NULL CHECK(json_valid(refs)), requirement_version INTEGER, occurred_at TEXT,
      UNIQUE(requirement_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS requirement_lifecycle_events_root
      ON requirement_lifecycle_events(requirement_id, seq);
    CREATE TABLE IF NOT EXISTS requirement_lifecycle_links (
      requirement_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
      requirement_version INTEGER, refs TEXT NOT NULL CHECK(json_valid(refs)), occurred_at TEXT,
      PRIMARY KEY(requirement_id, kind, entity_id)
    );
    CREATE INDEX IF NOT EXISTS requirement_lifecycle_links_entity
      ON requirement_lifecycle_links(kind, entity_id);
    CREATE TABLE IF NOT EXISTS requirement_lifecycle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requirement_deliveries (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, requirement_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('submitted','accepted','rejected')),
      summary TEXT NOT NULL, evidence TEXT NOT NULL CHECK(json_valid(evidence)),
      run_ids TEXT NOT NULL CHECK(json_valid(run_ids)), actor TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requirement_deliveries_root ON requirement_deliveries(requirement_id, created_at);
    CREATE TABLE IF NOT EXISTS requirement_delivery_reviews (
      id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, decision TEXT NOT NULL,
      comment TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requirement_lifecycle_operations (
      requirement_id TEXT NOT NULL, actor_key TEXT NOT NULL, entry_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, delivery_id TEXT NOT NULL, operation TEXT NOT NULL,
      PRIMARY KEY(requirement_id, actor_key, entry_key)
    );
    INSERT OR IGNORE INTO requirement_lifecycle_stamps(requirement_id,updated_at,version)
      SELECT requirement_id,updated_at,version FROM requirement_lifecycle_versions WHERE updated_at<>'';
    INSERT OR IGNORE INTO requirement_lifecycle_stamps(requirement_id,updated_at,version)
      SELECT requirement_id,current_updated_at,current_version FROM requirement_lifecycle_roots WHERE current_updated_at<>'';
  `);
}
