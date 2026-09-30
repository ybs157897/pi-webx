import type Database from 'better-sqlite3';

const BASELINE_KEY = 'mutation_journal_baseline_v1';
const UTC_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** Triggers capture every requirements/tasks SQL mutation in the writer's transaction. */
export function installMutationJournal(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_mutations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        module TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('baseline','insert','update','delete','dataset_replaced')),
        before_payload TEXT CHECK(before_payload IS NULL OR json_valid(before_payload)),
        after_payload TEXT CHECK(after_payload IS NULL OR json_valid(after_payload)),
        occurred_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workbench_mutations_record
        ON workbench_mutations(module, record_id, seq);
      CREATE TRIGGER IF NOT EXISTS workbench_mutations_insert
      AFTER INSERT ON workbench_records
      WHEN NEW.module IN ('requirements','tasks')
      BEGIN
        INSERT INTO workbench_mutations
          (id,module,record_id,operation,before_payload,after_payload,occurred_at)
        VALUES (lower(hex(randomblob(16))),NEW.module,NEW.id,'insert',NULL,NEW.payload,${UTC_NOW});
      END;
      CREATE TRIGGER IF NOT EXISTS workbench_mutations_delete
      AFTER DELETE ON workbench_records
      WHEN OLD.module IN ('requirements','tasks')
      BEGIN
        INSERT INTO workbench_mutations
          (id,module,record_id,operation,before_payload,after_payload,occurred_at)
        VALUES (lower(hex(randomblob(16))),OLD.module,OLD.id,'delete',OLD.payload,NULL,${UTC_NOW});
      END;
      CREATE TRIGGER IF NOT EXISTS workbench_mutations_update
      AFTER UPDATE ON workbench_records
      BEGIN
        INSERT INTO workbench_mutations
          (id,module,record_id,operation,before_payload,after_payload,occurred_at)
        SELECT lower(hex(randomblob(16))),OLD.module,OLD.id,'delete',OLD.payload,NULL,${UTC_NOW}
        WHERE OLD.module IN ('requirements','tasks') AND (OLD.module <> NEW.module OR OLD.id <> NEW.id);
        INSERT INTO workbench_mutations
          (id,module,record_id,operation,before_payload,after_payload,occurred_at)
        SELECT lower(hex(randomblob(16))),NEW.module,NEW.id,'insert',NULL,NEW.payload,${UTC_NOW}
        WHERE NEW.module IN ('requirements','tasks') AND (OLD.module <> NEW.module OR OLD.id <> NEW.id);
        INSERT INTO workbench_mutations
          (id,module,record_id,operation,before_payload,after_payload,occurred_at)
        SELECT lower(hex(randomblob(16))),NEW.module,NEW.id,'update',OLD.payload,NEW.payload,${UTC_NOW}
        WHERE NEW.module IN ('requirements','tasks') AND OLD.module = NEW.module
          AND OLD.id = NEW.id AND OLD.payload IS NOT NEW.payload;
      END;
    `);
    const installed = db.prepare('SELECT 1 FROM workbench_meta WHERE key = ?').get(BASELINE_KEY);
    if (installed) return;
    db.prepare(`INSERT INTO workbench_mutations
      (id,module,record_id,operation,before_payload,after_payload,occurred_at)
      SELECT lower(hex(randomblob(16))),module,id,'baseline',NULL,payload,NULL
      FROM workbench_records WHERE module IN ('requirements','tasks') ORDER BY seq`).run();
    db.prepare('INSERT INTO workbench_meta(key,value) VALUES (?,?)').run(BASELINE_KEY, '1');
  }).immediate();
}

/** Import/reset/demo emit a boundary after their row events, inside the same transaction. */
export function appendDatasetReplacedMutation(db: Database.Database, requirements: readonly string[], tasks: readonly string[]): void {
  db.prepare(`INSERT INTO workbench_mutations
    (id,module,record_id,operation,before_payload,after_payload,occurred_at)
    VALUES (lower(hex(randomblob(16))),'*','*','dataset_replaced',NULL,?,${UTC_NOW})`)
    .run(JSON.stringify({ reason: 'import', requirements, tasks }));
}
