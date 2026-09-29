import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { ARRAY_MODULES, emptyState, demoState, validateFields } from './schema.mjs';
import { assertTaskSchedule, assertTaskShape } from '../modules/assistant/validation';

type ArrayModule = typeof ARRAY_MODULES[number];
type RecordRow = Record<string, unknown> & { id: string };
type SearchHit = { module: string; id: string; title: string; snippet: string };
type LinkEntry = { module: string; id: string; title: string };
type LinkGraph = { outgoing: LinkEntry[]; incoming: LinkEntry[] };

export type WorkbenchState = {
  version: number;
  profile: Record<string, unknown>;
  chatLog: unknown[];
} & Record<ArrayModule, RecordRow[]>;

type PayloadRow = { payload: string };
type RecordPayloadRow = { module: string; payload: string };

const DEFAULT_PROFILE = { name: '我', motto: '把日子过成想要的样子' };
const LEGACY_KB_ID = 'kb-legacy-default';

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

function parseRecord(payload: string): RecordRow {
  return JSON.parse(payload) as RecordRow;
}

/**
 * 旧 works 记录 → tasks 记录：排期并入计划字段（有完整时段视为固定安排），
 * 状态映射到 done，其余字段按待办默认值补齐。转换结果仍走 tasks 校验。
 */
function legacyWorkToTask(work: RecordRow): RecordRow {
  const start = typeof work.startTime === 'string' && work.startTime !== '' ? work.startTime : null;
  const end = typeof work.endTime === 'string' && work.endTime !== '' ? work.endTime : null;
  const done = work.status === 'done';
  const updatedAt = typeof work.updatedAt === 'string' ? work.updatedAt : new Date().toISOString();
  const createdAt = typeof work.createdAt === 'string' ? work.createdAt : updatedAt;
  const tags = Array.isArray(work.tags) ? work.tags : [];
  const clean = input(() => validateFields('tasks', {
    title: typeof work.title === 'string' && work.title.trim() !== '' ? work.title : '旧工作记录',
    note: typeof work.note === 'string' ? work.note : '',
    done,
    due: null,
    plannedDate: typeof work.scheduledDate === 'string' ? work.scheduledDate : null,
    startTime: start,
    endTime: end,
    kind: start !== null && end !== null ? 'fixed' : 'flexible',
    durationMinutes: 30,
    priority: 'normal',
    tag: typeof tags[0] === 'string' ? tags[0] : '',
    originalText: '',
    refs: Array.isArray(work.refs) ? work.refs : [],
    starred: work.starred === true,
    tags: [],
  }));
  return { id: work.id, ...clean, createdAt, updatedAt, doneAt: done ? updatedAt : null };
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

  // 旧导出兼容：works 数组并入 tasks，lifePlans 数组改挂 plans；两个旧键都只是
  // 键名不同，记录本身仍是同一套字段，因此只做映射，不做双写。
  const legacyWorks = source.works;
  if (legacyWorks !== undefined && !Array.isArray(legacyWorks)) throw new WorkbenchInputError('缺少 works 记录数组');
  const legacyPlans = source.lifePlans;
  if (legacyPlans !== undefined && !Array.isArray(legacyPlans)) throw new WorkbenchInputError('缺少 lifePlans 记录数组');

  const taskIds = new Set(state.tasks.map(task => task.id));
  const workIds = new Set<string>();
  for (const value of (legacyWorks ?? []) as unknown[]) {
    if (!isObject(value) || typeof value.id !== 'string' || workIds.has(value.id)) {
      throw new WorkbenchInputError('works 含有无效或重复的记录 ID');
    }
    workIds.add(value.id);
    const task = legacyWorkToTask({ ...value, id: value.id });
    if (taskIds.has(task.id)) task.id = randomUUID();
    taskIds.add(task.id);
    state.tasks.push(task);
  }

  const planIds = new Set(state.plans.map(plan => plan.id));
  for (const plan of (legacyPlans ?? []) as unknown[]) {
    if (!isObject(plan) || typeof plan.id !== 'string' || planIds.has(plan.id)) {
      throw new WorkbenchInputError('plans 含有无效或重复的记录 ID');
    }
    input(() => validateFields('plans', plan));
    planIds.add(plan.id);
    const row = structuredClone(plan) as RecordRow;
    if (typeof row.createdAt !== 'string') row.createdAt = new Date().toISOString();
    if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
    state.plans.push(row);
  }

  for (const task of state.tasks) {
    assertTaskShape(task);
    assertTaskSchedule(task, state.tasks);
  }
  const captures = new Set<string>();
  for (const task of state.tasks) {
    if (task.captureSessionId === undefined) continue;
    const key = JSON.stringify([task.captureSessionId, task.captureEntryKey]);
    if (captures.has(key)) throw new WorkbenchInputError('导入数据中待办收集标识重复');
    captures.add(key);
  }

  const baseIds = new Set(state.knowledgeBases.map(base => base.id));
  const folders = new Map(state.knowledgeFolders.map(folder => [folder.id, folder]));
  for (const folder of state.knowledgeFolders) {
    if (!baseIds.has(String(folder.knowledgeBaseId))) throw new WorkbenchInputError('知识目录指向不存在的知识库');
    const seen = new Set([folder.id]);
    let parentId = String(folder.parentId ?? '');
    while (parentId !== '') {
      if (seen.has(parentId)) throw new WorkbenchInputError('知识目录存在循环层级');
      seen.add(parentId);
      const parent = folders.get(parentId);
      if (!parent || parent.knowledgeBaseId !== folder.knowledgeBaseId) throw new WorkbenchInputError('知识目录的上级目录不在同一个知识库');
      parentId = String(parent.parentId ?? '');
    }
  }
  for (const doc of state.knowledge) {
    if (doc.knowledgeBaseId && !baseIds.has(String(doc.knowledgeBaseId))) throw new WorkbenchInputError('知识文档指向不存在的知识库');
    if (doc.folderId && folders.get(String(doc.folderId))?.knowledgeBaseId !== doc.knowledgeBaseId) {
      throw new WorkbenchInputError('知识文档的目录不在同一个知识库');
    }
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
    `);
    this.migrateLegacyKnowledge();
    this.migrateLegacyModules();
  }

  private getArrayRecord(module: string, id: string): RecordRow | null {
    const row = this.db.prepare('SELECT payload FROM workbench_records WHERE module = ? AND id = ?').get(module, id) as PayloadRow | undefined;
    return row ? parseRecord(row.payload) : null;
  }

  private ensureLegacyBase(): string {
    if (this.getArrayRecord('knowledgeBases', LEGACY_KB_ID)) return LEGACY_KB_ID;
    const now = new Date().toISOString();
    const base = { id: LEGACY_KB_ID, title: '我的知识库', description: '从原有知识笔记整理而来', tags: [], refs: [], starred: false, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO workbench_records (module, id, payload) VALUES (?, ?, ?)')
      .run('knowledgeBases', base.id, JSON.stringify(base));
    return LEGACY_KB_ID;
  }

  private migrateLegacyKnowledge(): void {
    const rows = this.db.prepare('SELECT id, payload FROM workbench_records WHERE module = ?').all('knowledge') as Array<{ id: string; payload: string }>;
    const legacy = rows.map(row => ({ id: row.id, record: parseRecord(row.payload) })).filter(row => !row.record.knowledgeBaseId);
    if (legacy.length === 0) return;
    this.db.transaction(() => {
      const baseId = this.ensureLegacyBase();
      const update = this.db.prepare('UPDATE workbench_records SET payload = ? WHERE module = ? AND id = ?');
      for (const row of legacy) update.run(JSON.stringify({ ...row.record, knowledgeBaseId: baseId, folderId: '' }), 'knowledge', row.id);
    })();
  }

  /**
   * works / lifePlans 两个旧模块合并进 tasks / plans：works 记录逐条转成待办，
   * lifePlans 只改模块键，最后删掉旧键与 works 的幂等绑定表。全部步骤在同一个
   * sqlite 事务里，任何一条失败整体回滚；数据已经迁移过时三步都是空操作。
   */
  private migrateLegacyModules(): void {
    const works = this.db.prepare("SELECT id, payload FROM workbench_records WHERE module = 'works'").all() as Array<{ id: string; payload: string }>;
    const legacyPlans = this.db.prepare("SELECT count(*) AS total FROM workbench_records WHERE module = 'lifePlans'").get() as { total: number };
    const bindings = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'works_schedule_entries'").get() as { name: string } | undefined;
    if (works.length === 0 && legacyPlans.total === 0 && bindings === undefined) return;
    this.db.transaction(() => {
      const insert = this.db.prepare('INSERT INTO workbench_records (module, id, payload) VALUES (?, ?, ?)');
      const taskIds = new Set((this.db.prepare("SELECT id FROM workbench_records WHERE module = 'tasks'").all() as Array<{ id: string }>).map(row => row.id));
      for (const row of works) {
        const task = legacyWorkToTask(parseRecord(row.payload));
        if (taskIds.has(task.id)) task.id = randomUUID();
        taskIds.add(task.id);
        insert.run('tasks', task.id, JSON.stringify(task));
      }
      this.db.prepare("UPDATE workbench_records SET module = 'plans' WHERE module = 'lifePlans'").run();
      this.db.prepare("DELETE FROM workbench_records WHERE module = 'works'").run();
      this.db.exec('DROP TABLE IF EXISTS works_schedule_entries');
    })();
  }

  private validateKnowledgeLocation(record: RecordRow): void {
    const baseId = String(record.knowledgeBaseId ?? '');
    if (!this.getArrayRecord('knowledgeBases', baseId)) throw new WorkbenchInputError('知识库不存在', 404);
    const folderId = String(record.folderId ?? '');
    if (folderId !== '' && this.getArrayRecord('knowledgeFolders', folderId)?.knowledgeBaseId !== baseId) {
      throw new WorkbenchInputError('目录不属于所选知识库');
    }
  }

  private validateFolder(record: RecordRow): void {
    const baseId = String(record.knowledgeBaseId ?? '');
    if (!this.getArrayRecord('knowledgeBases', baseId)) throw new WorkbenchInputError('知识库不存在', 404);
    const seen = new Set([record.id]);
    let parentId = String(record.parentId ?? '');
    while (parentId !== '') {
      if (seen.has(parentId)) throw new WorkbenchInputError('目录不能形成循环层级');
      seen.add(parentId);
      const parent = this.getArrayRecord('knowledgeFolders', parentId);
      if (!parent || parent.knowledgeBaseId !== baseId) throw new WorkbenchInputError('上级目录不属于所选知识库');
      parentId = String(parent.parentId ?? '');
    }
  }

  close(): void {
    this.db.close();
  }

  /** @internal 同库协作模块（模块 Agent 绑定表）复用同一连接与其事务。 */
  get sqlite(): Database.Database {
    return this.db;
  }

  /** 单个数组模块的全部记录（按写入顺序），给领域服务做内存内过滤用。 */
  listRecords(module: string): RecordRow[] {
    arrayModule(module);
    const rows = this.db.prepare('SELECT payload FROM workbench_records WHERE module = ? ORDER BY seq').all(module) as PayloadRow[];
    return rows.map((row) => parseRecord(row.payload));
  }

  /**
   * 受限知识检索：库归属过滤下推到 SQL（json_extract），limit 语义因此不受
   * 「先全库取回再过滤」的截断污染。排序与全模块 search 一致：标题命中优先。
   */
  searchKnowledge(
    baseIds: readonly string[],
    query: string,
    limit = 20,
  ): Array<{ id: string; title: string; snippet: string; knowledgeBaseId: string }> {
    const q = query.trim();
    if (q === '' || baseIds.length === 0 || limit < 1) return [];
    const like = `%${q.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    const placeholders = baseIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT payload FROM workbench_records
       WHERE module = 'knowledge'
         AND payload LIKE ? ESCAPE '\\'
         AND json_extract(payload, '$.knowledgeBaseId') IN (${placeholders})
       ORDER BY seq DESC LIMIT ?`,
    ).all(like, ...baseIds, limit * 2) as PayloadRow[];
    const hits = rows.map((row) => {
      const record = parseRecord(row.payload);
      const hit = hitOf('knowledge', record);
      return { id: record.id, title: hit.title, snippet: hit.snippet, knowledgeBaseId: String(record.knowledgeBaseId) };
    });
    hits.sort((left, right) => rankOf(right) - rankOf(left) || right.snippet.length - left.snippet.length);
    function rankOf(hit: { title: string }): number {
      return hit.title.toLowerCase().includes(q.toLowerCase()) ? 1 : 0;
    }
    return hits.slice(0, limit);
  }

  /** 按 id 读一条知识记录（含 knowledgeBaseId，归属核对由调用方负责）。 */
  readKnowledge(id: string): RecordRow | null {
    const row = this.db.prepare("SELECT payload FROM workbench_records WHERE module = 'knowledge' AND id = ?").get(id) as PayloadRow | undefined;
    return row ? parseRecord(row.payload) : null;
  }

  read(): WorkbenchState {
    const state = emptyState(DEFAULT_PROFILE) as WorkbenchState;
    const profile = this.db.prepare('SELECT value FROM workbench_meta WHERE key = ?').get('profile') as { value: string } | undefined;
    if (profile) state.profile = JSON.parse(profile.value) as Record<string, unknown>;
    const records = this.db.prepare('SELECT module, payload FROM workbench_records ORDER BY seq').all() as RecordPayloadRow[];
    for (const row of records) {
      if (ARRAY_MODULES.includes(row.module as ArrayModule)) state[row.module as ArrayModule].push(parseRecord(row.payload));
    }
    return state;
  }

  /** R3：正文双链只解析当前知识库标题，来源引用沿用本次写入后的 refs。 */
  private knowledgeRefs(body: string, selfId: string, baseId: string, keepRefs: Array<{ type: string; id: string }>): Array<{ type: string; id: string }> {
    const rows = this.db.prepare('SELECT payload FROM workbench_records WHERE module = ? ORDER BY seq').all('knowledge') as PayloadRow[];
    const byTitle = new Map<string, string[]>();
    for (const row of rows) {
      const note = parseRecord(row.payload);
      const title = typeof note.title === 'string' ? note.title.trim() : '';
      if (title === '' || note.id === selfId || note.knowledgeBaseId !== baseId) continue;
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
    if (module === 'knowledge') {
      if (!record.knowledgeBaseId) record.knowledgeBaseId = this.ensureLegacyBase();
      this.validateKnowledgeLocation(record);
    }
    if (module === 'knowledgeFolders') this.validateFolder(record);
    if (module === 'knowledge' && isObject(fields) && typeof fields.body === 'string') {
      record.refs = this.knowledgeRefs(fields.body, record.id, String(record.knowledgeBaseId), refsOf(record));
    }
    if (module === 'tasks') {
      assertTaskShape(record);
      assertTaskSchedule(record, this.listRecords('tasks'));
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
    if (module === 'requirements' && record.importedAt && Object.hasOwn(clean, 'taskDrafts')) {
      throw new WorkbenchInputError('已导入需求的待办草稿不能再修改', 409);
    }
    if (module === 'knowledge') this.validateKnowledgeLocation(record);
    if (module === 'knowledgeFolders') this.validateFolder(record);
    if (module === 'knowledge' && (typeof clean.body === 'string' || typeof clean.knowledgeBaseId === 'string')) {
      record.refs = this.knowledgeRefs(String(record.body ?? ''), id, String(record.knowledgeBaseId), refsOf(record));
    }
    if (module === 'tasks') {
      assertTaskShape(record);
      assertTaskSchedule(record, this.listRecords('tasks'));
    }
    if (module === 'tasks' && clean.done !== undefined) record.doneAt = clean.done ? new Date().toISOString() : null;
    if (STAMPED_MODULES.has(module)) {
      const previous = Date.parse(String(record.updatedAt ?? ''));
      record.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    }
    this.db.prepare('UPDATE workbench_records SET payload = ? WHERE module = ? AND id = ?')
      .run(JSON.stringify(record), module, id);
    return record;
  }

  removeRecord(module: string, id: string): boolean {
    arrayModule(module);
    if (module === 'knowledgeBases') {
      return this.db.transaction(() => {
        const base = this.getArrayRecord(module, id);
        if (!base) return false;
        for (const childModule of ['knowledge', 'knowledgeFolders']) {
          const rows = this.db.prepare('SELECT id, payload FROM workbench_records WHERE module = ?').all(childModule) as Array<{ id: string; payload: string }>;
          const remove = this.db.prepare('DELETE FROM workbench_records WHERE module = ? AND id = ?');
          for (const row of rows) if (parseRecord(row.payload).knowledgeBaseId === id) remove.run(childModule, row.id);
        }
        this.db.prepare('DELETE FROM workbench_records WHERE module = ? AND id = ?').run(module, id);
        return true;
      })();
    }
    if (module === 'knowledgeFolders') {
      const hasChild = this.db.prepare('SELECT payload FROM workbench_records WHERE module IN (?, ?)').all('knowledge', 'knowledgeFolders') as PayloadRow[];
      if (hasChild.some(row => {
        const record = parseRecord(row.payload);
        return record.folderId === id || record.parentId === id;
      })) throw new WorkbenchInputError('目录中仍有文档或子目录，请先移走');
    }
    const result = this.db.prepare('DELETE FROM workbench_records WHERE module = ? AND id = ?').run(module, id);
    return result.changes > 0;
  }

  import(raw: unknown): void {
    const state = normalizeImport(raw);
    const insertRecord = this.db.prepare('INSERT INTO workbench_records (module, id, payload) VALUES (?, ?, ?)');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workbench_records').run();
      this.db.prepare('INSERT INTO workbench_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('profile', JSON.stringify(state.profile));
      for (const module of ARRAY_MODULES) {
        for (const record of state[module]) insertRecord.run(module, record.id, JSON.stringify(record));
      }
      this.migrateLegacyKnowledge();
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
      if (row.module === 'plans') continue;
      const record = parseRecord(row.payload);
      hits.push(hitOf(row.module, record));
    }
    hits.sort((left, right) => rankOf(right) - rankOf(left) || right.snippet.length - left.snippet.length);
    function rankOf(hit: SearchHit): number {
      return hit.title.toLowerCase().includes(q.toLowerCase()) ? 1 : 0;
    }
    return hits.slice(0, limit);
  }

  /**
   * 双向链接查询：出链 = 本条记录 refs 指向的记录；反链 = 全表里 refs 指向本条
   * 记录的记录。
   * 元素统一为 { module, id, title }；指向不存在记录的引用视为已删除，不入列。
   * @param module - 模块 key。
   * @param id - 记录 id。
   * @returns `{ outgoing, incoming }`，记录不存在时两者都是空数组。
   */
  links(module: string, id: string): LinkGraph {
    arrayModule(module);
    const all: Array<{ entry: LinkEntry; refs: Array<{ type: string; id: string }> }> = [];
    const arrayRows = this.db.prepare('SELECT module, payload FROM workbench_records').all() as RecordPayloadRow[];
    for (const row of arrayRows) {
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
   * 键清单与前端模块一一对齐：theme / density 全局外观，transcriptView AI 对话的工作
   * 步骤展示模式，panelOpen AI 面板默认开合，tasksScope 模块的视图，
   * kbSelectedId / kbView 知识库的选中条目与编辑/预览视图——后两个漏在白名单外会被静默
   * 丢弃，用户刷新后必然丢状态。
   */
  writePrefs(patch: unknown): Record<string, unknown> {
    if (!isObject(patch)) throw new WorkbenchInputError('偏好需要是对象');
    const allowed = new Set([
      'theme', 'density', 'transcriptView', 'panelOpen', 'tasksScope', 'kbSelectedId', 'kbView', 'kbBaseId', 'kbStage',
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
  const title = [record.title, record.text]
    .find(value => typeof value === 'string' && value.trim() !== '') ?? module;
  const body = [record.note, record.text, record.title].find(value => typeof value === 'string' && value.trim() !== '');
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  const destination = module === 'knowledgeBases' || module === 'knowledgeFolders' ? 'knowledge' : module;
  return { module: destination, id: record.id, title: String(title), snippet: flat.length > 80 ? `${flat.slice(0, 80)}…` : flat };
}
