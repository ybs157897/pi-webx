import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  ARRAY_MODULES, ATOM_MODULES, emptyState, demoState, validateAtomProfile,
  validateAtomRecord, validateFields,
} from './schema.mjs';

type ArrayModule = typeof ARRAY_MODULES[number];
type AtomModule = typeof ATOM_MODULES[number];
type RecordRow = Record<string, unknown> & { id: string };
type Atom = { profile: Record<string, unknown>; records: RecordRow[] };
type SearchHit = { module: string; id: string; title: string; snippet: string };
type LinkEntry = { module: string; id: string; title: string };
type LinkGraph = { outgoing: LinkEntry[]; incoming: LinkEntry[] };

export type WorkbenchState = {
  version: number;
  profile: Record<string, unknown>;
  chatLog: unknown[];
} & Record<ArrayModule, RecordRow[]> & Record<AtomModule, Atom>;

type PayloadRow = { payload: string };
type RecordPayloadRow = { module: string; payload: string };
type AtomProfileRow = { module: string; payload: string };

const DEFAULT_PROFILE = { name: '我', motto: '把日子过成想要的样子' };

/** 全部数组模块都维护 createdAt / updatedAt（旧记录导入时缺省由导入方补齐）。 */
const STAMPED_MODULES: ReadonlySet<string> = new Set(ARRAY_MODULES);

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

function anyModule(name: string): void {
  if (!ARRAY_MODULES.includes(name as ArrayModule) && !ATOM_MODULES.includes(name as AtomModule)) {
    throw new WorkbenchInputError(`未知模块：${name}`);
  }
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
    // 向后兼容：新增模块（如 knowledge）在旧导出里没有这个键，缺键当空数组；
    // 键存在但类型不对仍然是坏数据，照旧抛错。
    if (records !== undefined && !Array.isArray(records)) throw new WorkbenchInputError(`缺少 ${module} 记录数组`);
    const ids = new Set<string>();
    state[module] = (Array.isArray(records) ? records : []).map((record: unknown) => {
      if (!isObject(record) || typeof record.id !== 'string' || ids.has(record.id)) {
        throw new WorkbenchInputError(`${module} 含有无效或重复的记录 ID`);
      }
      input(() => validateFields(module, record));
      ids.add(record.id);
      // 旧数据没有时间戳字段：导入时统一补齐，界面上的「更新时间」才不会空着。
      const row = structuredClone(record) as RecordRow;
      if (STAMPED_MODULES.has(module)) {
        if (typeof row.createdAt !== 'string') row.createdAt = new Date().toISOString();
        if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
      }
      return row;
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

  /** R3：正文双链只解析当前知识库标题，来源引用沿用本次写入后的 refs。 */
  private knowledgeRefs(body: string, selfId: string, keepRefs: Array<{ type: string; id: string }>): Array<{ type: string; id: string }> {
    const rows = this.db.prepare('SELECT payload FROM workbench_records WHERE module = ? ORDER BY seq').all('knowledge') as PayloadRow[];
    const byTitle = new Map<string, string[]>();
    for (const row of rows) {
      const note = parseRecord(row.payload);
      const title = typeof note.title === 'string' ? note.title.trim() : '';
      if (title === '' || note.id === selfId) continue;
      const ids = byTitle.get(title) ?? [];
      ids.push(note.id);
      byTitle.set(title, ids);
    }
    const refs: Array<{ type: string; id: string }> = [];
    const seen = new Set<string>();
    const add = (type: string, id: string): void => {
      const key = JSON.stringify([type, id]);
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ type, id });
      }
    };
    for (const match of body.matchAll(/\[\[([^\[\]\n]+?)\]\]/g)) {
      const title = match[1]?.trim() ?? '';
      for (const id of byTitle.get(title) ?? []) add('knowledge', id);
    }
    for (const ref of keepRefs) {
      if (ref.type !== '' && ref.type !== 'knowledge') add(ref.type, ref.id);
    }
    return refs.slice(0, 20);
  }

  addRecord(module: string, fields: unknown): RecordRow {
    arrayModule(module);
    const clean = input(() => validateFields(module, fields));
    const now = new Date().toISOString();
    const record: RecordRow = {
      id: randomUUID(), ...clean,
      ...(module === 'tasks' ? { createdAt: now, doneAt: clean.done ? now : null } : {}),
      ...(STAMPED_MODULES.has(module) ? { createdAt: now, updatedAt: now } : {}),
    };
    if (module === 'knowledge' && isObject(fields) && typeof fields.body === 'string') {
      record.refs = this.knowledgeRefs(fields.body, record.id, refsOf(record));
    }
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
    if (module === 'knowledge' && typeof clean.body === 'string') {
      record.refs = this.knowledgeRefs(clean.body, id, refsOf(record));
    }
    if (module === 'tasks' && clean.done !== undefined) record.doneAt = clean.done ? new Date().toISOString() : null;
    if (STAMPED_MODULES.has(module)) record.updatedAt = new Date().toISOString();
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

  /** 库里有没有任何记录（首启引导：空库才提示灌演示数据）。 */
  isEmpty(): boolean {
    const row = this.db.prepare('SELECT count(*) AS total FROM workbench_records').get() as { total: number };
    return row.total === 0;
  }

  /** 全模块搜索：命令面板的数据源。LIKE 通配符转义，标题命中优先。 */
  search(query: string, limit = 20): SearchHit[] {
    const q = query.trim();
    if (q === '') return [];
    const like = `%${q.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    const hits: SearchHit[] = [];
    const rows = this.db.prepare(
      "SELECT module, payload FROM workbench_records WHERE payload LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?",
    ).all(like, limit * 2) as RecordPayloadRow[];
    for (const row of rows) {
      const record = parseRecord(row.payload);
      hits.push(hitOf(row.module, record));
    }
    const atomRows = this.db.prepare(
      "SELECT module, payload FROM workbench_atom_records WHERE payload LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?",
    ).all(like, limit) as RecordPayloadRow[];
    for (const row of atomRows) {
      hits.push(hitOf(row.module, parseRecord(row.payload)));
    }
    hits.sort((left, right) => rankOf(right) - rankOf(left) || right.snippet.length - left.snippet.length);
    function rankOf(hit: SearchHit): number {
      return hit.title.toLowerCase().includes(q.toLowerCase()) ? 1 : 0;
    }
    return hits.slice(0, limit);
  }

  /**
   * 双向链接查询：出链 = 本条记录 refs 指向的记录；反链 = 全部记录（含
   * pets / relationships 时间轴）里 refs 指向本条记录的记录。
   * 元素统一为 { module, id, title }；指向不存在记录的引用视为已删除，不入列。
   * @param module - 模块 key（数组模块或资料模块）。
   * @param id - 记录 id。
   * @returns `{ outgoing, incoming }`，记录不存在时两者都是空数组。
   */
  links(module: string, id: string): LinkGraph {
    anyModule(module);
    const all: Array<{ entry: LinkEntry; refs: Array<{ type: string; id: string }> }> = [];
    const arrayRows = this.db.prepare('SELECT module, payload FROM workbench_records').all() as RecordPayloadRow[];
    for (const row of arrayRows) {
      const record = parseRecord(row.payload);
      all.push({ entry: { module: row.module, id: record.id, title: hitOf(row.module, record).title }, refs: refsOf(record) });
    }
    const atomRows = this.db.prepare('SELECT module, payload FROM workbench_atom_records').all() as RecordPayloadRow[];
    for (const row of atomRows) {
      const record = parseRecord(row.payload);
      all.push({ entry: { module: row.module, id: record.id, title: hitOf(row.module, record).title }, refs: refsOf(record) });
    }
    const titles = new Map<string, string>(all.map(item => [`${item.entry.module}:${item.entry.id}`, item.entry.title] as const));
    const outgoing: LinkEntry[] = [];
    const seen = new Set<string>();
    for (const item of all) {
      if (item.entry.module !== module || item.entry.id !== id) continue;
      for (const ref of item.refs) {
        const key = `${ref.type}:${ref.id}`;
        if (seen.has(key) || !titles.has(key)) continue;
        seen.add(key);
        outgoing.push({ module: ref.type, id: ref.id, title: titles.get(key) as string });
      }
    }
    const incoming: LinkEntry[] = [];
    for (const item of all) {
      if (item.refs.some(ref => ref.type === module && ref.id === id)) incoming.push(item.entry);
    }
    return { outgoing, incoming };
  }

  /** 读界面偏好（主题 / 密度 / AI 面板默认开合等）。 */
  readPrefs(): Record<string, unknown> {
    const row = this.db.prepare('SELECT value FROM workbench_meta WHERE key = ?').get('ui_prefs') as { value: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * 合并写界面偏好（白名单键，防止把任意 JSON 塞进 meta 表）。
   * 键清单与前端模块一一对齐：theme / density 全局外观，panelOpen AI 面板默认开合，
   * worksView / tasksScope 两个模块的视图，kbSelectedId / kbView 知识库的选中条目与
   * 编辑/预览视图——后两个漏在白名单外会被静默丢弃，用户刷新后必然丢状态。
   */
  writePrefs(patch: unknown): Record<string, unknown> {
    if (!isObject(patch)) throw new WorkbenchInputError('偏好需要是对象');
    const allowed = new Set([
      'theme', 'density', 'panelOpen', 'worksView', 'tasksScope', 'kbSelectedId', 'kbView',
    ]);
    const merged = { ...this.readPrefs() };
    for (const [key, value] of Object.entries(patch)) {
      if (allowed.has(key)) merged[key] = value;
    }
    this.db.prepare('INSERT INTO workbench_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('ui_prefs', JSON.stringify(merged));
    return merged;
  }

  /** 灌入演示数据（覆盖现有内容）。 */
  loadDemo(): void {
    this.import(demoState());
  }

  /** 清空全部记录（保留 profile）。 */
  resetAll(): void {
    this.import(emptyState(this.read().profile));
  }
}

/** 提取一条记录里的 refs 关联数组：容忍旧数据缺字段或形状不符的项。 */
function refsOf(record: RecordRow): Array<{ type: string; id: string }> {
  const refs = record.refs;
  if (!Array.isArray(refs)) return [];
  const out: Array<{ type: string; id: string }> = [];
  for (const item of refs) {
    if (isObject(item) && typeof item.type === 'string' && typeof item.id === 'string') {
      out.push({ type: item.type, id: item.id });
    }
  }
  return out;
}

/** 从一条记录里提取标题与摘要：优先人读字段，兜底 JSON 原文截断。 */
function hitOf(module: string, record: RecordRow): SearchHit {
  const title = [record.title, record.text, record.type, record.food, record.category]
    .find(value => typeof value === 'string' && value.trim() !== '') ?? module;
  const body = [record.note, record.text, record.title].find(value => typeof value === 'string' && value.trim() !== '');
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  return { module, id: record.id, title: String(title), snippet: flat.length > 80 ? `${flat.slice(0, 80)}…` : flat };
}
