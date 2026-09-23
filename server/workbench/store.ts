import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  ARRAY_MODULES, ATOM_MODULES, emptyState, validateAtomProfile,
  validateAtomRecord, validateFields,
} from './schema.mjs';

type ArrayModule = typeof ARRAY_MODULES[number];
type AtomModule = typeof ATOM_MODULES[number];
type RecordRow = Record<string, unknown> & { id: string };
type Atom = { profile: Record<string, unknown>; records: RecordRow[] };

export type WorkbenchState = {
  version: number;
  profile: Record<string, unknown>;
  chatLog: unknown[];
} & Record<ArrayModule, RecordRow[]> & Record<AtomModule, Atom>;

type PayloadRow = { payload: string };
type RecordPayloadRow = { module: string; payload: string };
type AtomProfileRow = { module: string; payload: string };

const DEFAULT_PROFILE = { name: '我', motto: '把日子过成想要的样子' };

export class WorkbenchInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function input<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new WorkbenchInputError(error instanceof Error ? error.message : String(error));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arrayModule(name: string): asserts name is ArrayModule {
  if (!ARRAY_MODULES.includes(name as ArrayModule)) throw new WorkbenchInputError(`未知模块：${name}`);
}

function atomModule(name: string): asserts name is AtomModule {
  if (!ATOM_MODULES.includes(name as AtomModule)) throw new WorkbenchInputError(`未知资料模块：${name}`);
}

function parseRecord(payload: string): RecordRow {
  return JSON.parse(payload) as RecordRow;
}

function normalizeImport(raw: unknown): WorkbenchState {
  if (!isObject(raw)) throw new WorkbenchInputError('文件不是工作台数据对象');
  const source = isObject(raw.data) ? raw.data : raw;
  const importedProfile = isObject(source.profile) ? source.profile : DEFAULT_PROFILE;
  const state = emptyState({
    name: typeof importedProfile.name === 'string' ? importedProfile.name : DEFAULT_PROFILE.name,
    motto: typeof importedProfile.motto === 'string' ? importedProfile.motto : DEFAULT_PROFILE.motto,
  }) as WorkbenchState;

  for (const module of ARRAY_MODULES) {
    const records = source[module];
    if (!Array.isArray(records)) throw new WorkbenchInputError(`缺少 ${module} 记录数组`);
    const ids = new Set<string>();
    state[module] = records.map((record: unknown) => {
      if (!isObject(record) || typeof record.id !== 'string' || ids.has(record.id)) {
        throw new WorkbenchInputError(`${module} 含有无效或重复的记录 ID`);
      }
      input(() => validateFields(module, record));
      ids.add(record.id);
      return structuredClone(record) as RecordRow;
    });
  }

  for (const module of ATOM_MODULES) {
    const atom = source[module];
    if (!isObject(atom) || !Array.isArray(atom.records)) throw new WorkbenchInputError(`缺少 ${module} 资料模块`);
    const profile = isObject(atom.profile) ? atom.profile : {};
    input(() => validateAtomProfile(module, profile, { partial: true }));
    const ids = new Set<string>();
    state[module] = {
      profile: structuredClone(profile),
      records: atom.records.map((record: unknown) => {
        if (!isObject(record) || typeof record.id !== 'string' || ids.has(record.id)) {
          throw new WorkbenchInputError(`${module} 含有无效或重复的记录 ID`);
        }
        input(() => validateAtomRecord(record));
        ids.add(record.id);
        return structuredClone(record) as RecordRow;
      }),
    };
  }
  return state;
}

export function defaultWorkbenchDbPath(): string {
  return process.env['AI_WORKBENCH_DB_PATH']?.trim() || join(homedir(), '.pi-webx', 'workbench.sqlite');
}

export class WorkbenchStore {
  private readonly db: Database.Database;

  constructor(dbPath = defaultWorkbenchDbPath()) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workbench_records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        UNIQUE (module, id)
      );
      CREATE INDEX IF NOT EXISTS workbench_records_module_seq ON workbench_records(module, seq);
      CREATE TABLE IF NOT EXISTS workbench_atom_profiles (
        module TEXT PRIMARY KEY,
        payload TEXT NOT NULL CHECK (json_valid(payload))
      );
      CREATE TABLE IF NOT EXISTS workbench_atom_records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        UNIQUE (module, id)
      );
      CREATE INDEX IF NOT EXISTS workbench_atom_records_module_seq ON workbench_atom_records(module, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  read(): WorkbenchState {
    const state = emptyState(DEFAULT_PROFILE) as WorkbenchState;
    const profile = this.db.prepare('SELECT value FROM workbench_meta WHERE key = ?').get('profile') as { value: string } | undefined;
    if (profile) state.profile = JSON.parse(profile.value) as Record<string, unknown>;
    const records = this.db.prepare('SELECT module, payload FROM workbench_records ORDER BY seq').all() as RecordPayloadRow[];
    for (const row of records) {
      if (ARRAY_MODULES.includes(row.module as ArrayModule)) state[row.module as ArrayModule].push(parseRecord(row.payload));
    }
    const profiles = this.db.prepare('SELECT module, payload FROM workbench_atom_profiles').all() as AtomProfileRow[];
    for (const row of profiles) {
      if (ATOM_MODULES.includes(row.module as AtomModule)) state[row.module as AtomModule].profile = JSON.parse(row.payload) as Record<string, unknown>;
    }
    const atomRecords = this.db.prepare('SELECT module, payload FROM workbench_atom_records ORDER BY seq').all() as RecordPayloadRow[];
    for (const row of atomRecords) {
      if (ATOM_MODULES.includes(row.module as AtomModule)) state[row.module as AtomModule].records.push(parseRecord(row.payload));
    }
    return state;
  }

  addRecord(module: string, fields: unknown): RecordRow {
    arrayModule(module);
    const clean = input(() => validateFields(module, fields));
    const now = new Date().toISOString();
    const record: RecordRow = {
      id: randomUUID(), ...clean,
      ...(module === 'tasks' ? { createdAt: now, doneAt: clean.done ? now : null } : {}),
      ...(module === 'works' ? { createdAt: now, updatedAt: now } : {}),
    };
    this.db.prepare('INSERT INTO workbench_records (module, id, payload) VALUES (?, ?, ?)')
      .run(module, record.id, JSON.stringify(record));
    return record;
  }

  updateRecord(module: string, id: string, patch: unknown): RecordRow {
    arrayModule(module);
    const clean = input(() => validateFields(module, patch, { partial: true }));
    const row = this.db.prepare('SELECT payload FROM workbench_records WHERE module = ? AND id = ?').get(module, id) as PayloadRow | undefined;
    if (!row) throw new WorkbenchInputError('记录不存在', 404);
    const record = { ...parseRecord(row.payload), ...clean };
    if (module === 'tasks' && clean.done !== undefined) record.doneAt = clean.done ? new Date().toISOString() : null;
    if (module === 'works') record.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE workbench_records SET payload = ? WHERE module = ? AND id = ?')
      .run(JSON.stringify(record), module, id);
    return record;
  }

  removeRecord(module: string, id: string): boolean {
    arrayModule(module);
    const result = this.db.prepare('DELETE FROM workbench_records WHERE module = ? AND id = ?').run(module, id);
    return result.changes > 0;
  }

  putAtomProfile(module: string, patch: unknown): Record<string, unknown> {
    atomModule(module);
    const clean = input(() => validateAtomProfile(module, patch, { partial: true }));
    const row = this.db.prepare('SELECT payload FROM workbench_atom_profiles WHERE module = ?').get(module) as PayloadRow | undefined;
    const profile = { ...(row ? JSON.parse(row.payload) as Record<string, unknown> : {}), ...clean };
    this.db.prepare('INSERT INTO workbench_atom_profiles (module, payload) VALUES (?, ?) ON CONFLICT(module) DO UPDATE SET payload = excluded.payload')
      .run(module, JSON.stringify(profile));
    return profile;
  }

  addAtomRecord(module: string, fields: unknown): RecordRow {
    atomModule(module);
    const clean = input(() => validateAtomRecord(fields));
    const record: RecordRow = { id: randomUUID(), ...clean };
    this.db.prepare('INSERT INTO workbench_atom_records (module, id, payload) VALUES (?, ?, ?)')
      .run(module, record.id, JSON.stringify(record));
    return record;
  }

  updateAtomRecord(module: string, id: string, patch: unknown): RecordRow {
    atomModule(module);
    const clean = input(() => validateAtomRecord(patch, { partial: true }));
    const row = this.db.prepare('SELECT payload FROM workbench_atom_records WHERE module = ? AND id = ?').get(module, id) as PayloadRow | undefined;
    if (!row) throw new WorkbenchInputError('记录不存在', 404);
    const record = { ...parseRecord(row.payload), ...clean };
    this.db.prepare('UPDATE workbench_atom_records SET payload = ? WHERE module = ? AND id = ?')
      .run(JSON.stringify(record), module, id);
    return record;
  }

  removeAtomRecord(module: string, id: string): boolean {
    atomModule(module);
    const result = this.db.prepare('DELETE FROM workbench_atom_records WHERE module = ? AND id = ?').run(module, id);
    return result.changes > 0;
  }

  import(raw: unknown): void {
    const state = normalizeImport(raw);
    const insertRecord = this.db.prepare('INSERT INTO workbench_records (module, id, payload) VALUES (?, ?, ?)');
    const insertAtomRecord = this.db.prepare('INSERT INTO workbench_atom_records (module, id, payload) VALUES (?, ?, ?)');
    const insertAtomProfile = this.db.prepare('INSERT INTO workbench_atom_profiles (module, payload) VALUES (?, ?)');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workbench_records').run();
      this.db.prepare('DELETE FROM workbench_atom_records').run();
      this.db.prepare('DELETE FROM workbench_atom_profiles').run();
      this.db.prepare('INSERT INTO workbench_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('profile', JSON.stringify(state.profile));
      for (const module of ARRAY_MODULES) {
        for (const record of state[module]) insertRecord.run(module, record.id, JSON.stringify(record));
      }
      for (const module of ATOM_MODULES) {
        insertAtomProfile.run(module, JSON.stringify(state[module].profile));
        for (const record of state[module].records) insertAtomRecord.run(module, record.id, JSON.stringify(record));
      }
    })();
  }
}
