import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchStore } from '../../workbench/store';
import type { LifecycleRoot } from './lifecycle-contracts';
import { ensureRequirementLifecycle } from './lifecycle-events';

/**
 * 需求文档投影：把需求库（SQLite）里的需求当前快照与生命周期事件渲染成绑定
 * 工作区内的只读 markdown 文档，供人阅读、git 追踪和普通文件工具读取。
 *
 * 真相源始终是需求库；本模块只做单向投影：用 requirement_projection_meta 的
 * mutation_cursor 对账 workbench_mutations 增量，可重复调用、确定性重建。
 * 写盘是文件 IO，不进 SQLite 事务；顺序固定为「一次查齐对账数据 → 写文件 →
 * 推进游标」，中途失败时游标不动，下次重跑覆盖同一批文件，结果等价。
 */

const PROJECTION_MODULE = 'requirements';
const PROJECTION_DIRNAME = 'requirements';

/** 投影首行固定声明只读，避免阅读者（包括模型）把投影当成可编辑事实。 */
const READONLY_NOTICE = '> 只读投影：由需求库自动生成，请勿手改；变更请通过需求工具或需求记录界面提交。';

const README = `# 需求库只读投影

本目录由需求库自动维护，是需求记录与变更历史的只读投影：供人阅读，供 git 追踪，也供普通文件工具读取。

## 生成规则

- 需求保存或修订后本目录会自动刷新，可能存在短暂滞后；如与需求库不一致，以需求库为准。
- 需求记录与历史变更全部来自需求库，本目录不承载可编辑状态。
- 请勿手工修改本目录内的任何文件；变更请通过需求工具或需求记录界面提交，手工修改会在下一次对账时被覆盖。

## 目录结构

- \`REQ-XXXXXX/requirement.md\`：需求当前快照，含真实需求 ID、状态、优先级、备注与待办草稿。
- \`REQ-XXXXXX/changes.md\`：需求的版本与事件时间线。
- 需求记录被删除后目录仍然保留，\`requirement.md\` 的状态标记为 \`deleted\`，用于追踪审计。
`;

type MutationRow = { seq: number; module: string; record_id: string };
type EventRow = { id: string; type: string; summary: string; occurred_at: string | null;
  requirement_version: number | null };
type RequirementSnapshot = { root: LifecycleRoot; payload: Record<string, unknown>; events: EventRow[] };
type ProjectionSnapshot = { cursor: number; targetSeq: number; requirements: RequirementSnapshot[] };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** 展示编号与 lifecycle 一致：REQ- + roots.seq 左补零 6 位，读回时按数字解析。 */
function displayId(seq: number): string {
  return `REQ-${String(seq).padStart(6, '0')}`;
}

function text(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  const rendered = String(value).trim();
  return rendered === '' ? fallback : rendered;
}

/** 备注按 markdown 原样输出，不做转义或重排；只有全空时才给占位说明。 */
function noteBody(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : '（无备注）';
}

function taskDraftLines(drafts: unknown): string[] {
  if (!Array.isArray(drafts) || drafts.length === 0) return ['（无待办草稿）'];
  return drafts.map((draft, index) => {
    const item = asRecord(draft);
    return `- ${index + 1}. ${text(item.title, '（未命名待办）')} · 优先级：${text(item.priority, 'normal')}`
      + ` · 截止：${text(item.due, '未设置')} · 标签：${text(item.tag, '无')}`;
  });
}

function renderRequirement(root: LifecycleRoot, payload: Record<string, unknown>): string {
  const deleted = root.archived === 1;
  const lines = [
    READONLY_NOTICE,
    '',
    `# ${text(payload.title, '（未命名需求）')}`,
    '',
    '## 元信息',
    '',
    `- 需求 ID：${root.requirement_id}`,
    `- 展示编号：${displayId(root.seq)}`,
    `- 状态：${deleted ? 'deleted' : text(payload.status, 'todo')}`,
    `- 优先级：${text(payload.priority, 'normal')}`,
    `- 当前版本：v${root.current_version}`,
    `- 更新时间：${text(root.current_updated_at, '时间未知')}`,
  ];
  if (deleted) lines.push('', '> 记录已删除，追踪审计保留。');
  lines.push('', '## 备注', '', noteBody(payload.note), '', '## 待办草稿', '', ...taskDraftLines(payload.taskDrafts), '');
  return lines.join('\n');
}

function renderChanges(root: LifecycleRoot, payload: Record<string, unknown>, events: EventRow[]): string {
  const lines = [READONLY_NOTICE, '', `# 变更历史：${text(payload.title, '（未命名需求）')}`, ''];
  if (events.length === 0) lines.push('（暂无变更记录）');
  for (const event of events) {
    const version = event.requirement_version === null ? '版本未知' : `v${event.requirement_version}`;
    lines.push(`- ${version} · ${text(event.occurred_at, '时间未知')} · ${event.type} · ${event.summary}`);
  }
  lines.push('', `- 当前版本：v${root.current_version} · 更新时间：${text(root.current_updated_at, '时间未知')}`, '');
  return lines.join('\n');
}

/**
 * 一次事务内查齐对账数据：游标、mutation 批次、每个涉及需求的 roots 与 events。
 * 用 immediate 事务取读锁，保证和并发写入之间拿到一致的快照。
 */
function readProjectionSnapshot(store: WorkbenchStore): ProjectionSnapshot {
  return store.sqlite.transaction((): ProjectionSnapshot => {
    store.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS requirement_projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const stored = store.sqlite.prepare(`SELECT value FROM requirement_projection_meta WHERE key='mutation_cursor'`)
      .get() as { value: string } | undefined;
    const parsed = Number(stored?.value ?? 0);
    const cursor = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
    const mutations = store.sqlite.prepare('SELECT seq, module, record_id FROM workbench_mutations WHERE seq>? ORDER BY seq')
      .all(cursor) as MutationRow[];
    // dataset_replaced 是 module='*' 的批次边界标记，不指向具体需求；涉及记录的变更
    // 会在同一事务内各自产生 mutation，这里只需把边界行连同批次一起跳过并推进游标。
    const targetSeq = mutations.at(-1)?.seq ?? cursor;
    const requirementIds = [...new Set(mutations
      .filter(mutation => mutation.module === PROJECTION_MODULE)
      .map(mutation => mutation.record_id))];
    const requirements: RequirementSnapshot[] = [];
    for (const id of requirementIds) {
      const root = store.sqlite.prepare('SELECT * FROM requirement_lifecycle_roots WHERE requirement_id=?')
        .get(id) as LifecycleRoot | undefined;
      // roots 里找不到记录时跳过渲染，但游标照常推进，避免卡死在同一个批次。
      if (!root) continue;
      const events = store.sqlite.prepare(`SELECT id, type, summary, occurred_at, requirement_version
        FROM requirement_lifecycle_events WHERE requirement_id=? ORDER BY occurred_at, id`).all(id) as EventRow[];
      requirements.push({ root, payload: asRecord(JSON.parse(root.payload)), events });
    }
    return { cursor, targetSeq, requirements };
  }).immediate();
}

export interface RequirementProjection {
  readonly workspaceDir: string;
  /** 游标对账：把 workbench_mutations 中 module='requirements' 的增量渲染成文档。幂等，可重复调用。 */
  sync(): Promise<void>;
}

export function createRequirementProjection(store: WorkbenchStore, workspaceDir: string): RequirementProjection {
  const rootDir = path.resolve(workspaceDir);
  const projectionDir = path.join(rootDir, PROJECTION_DIRNAME);

  async function writeDocument(directory: string, name: string, content: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), content, 'utf8');
  }

  return {
    workspaceDir: rootDir,
    async sync(): Promise<void> {
      // 1) 先让生命周期 journal 追平 mutation，再在一个事务里查齐本次对账数据。
      ensureRequirementLifecycle(store);
      const { cursor, targetSeq, requirements } = readProjectionSnapshot(store);

      // 2) 渲染写盘（文件 IO 不进 SQLite 事务）：README 固定内容，需求目录逐个覆盖写。
      await writeDocument(projectionDir, 'README.md', README);
      for (const requirement of requirements) {
        const directory = path.join(projectionDir, displayId(requirement.root.seq));
        await writeDocument(directory, 'requirement.md',
          renderRequirement(requirement.root, requirement.payload));
        await writeDocument(directory, 'changes.md',
          renderChanges(requirement.root, requirement.payload, requirement.events));
      }

      // 3) 整批写盘成功后才推进游标；失败时游标不动，下次重跑幂等覆盖。
      if (targetSeq > cursor) {
        store.sqlite.prepare(`INSERT INTO requirement_projection_meta(key,value) VALUES ('mutation_cursor',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(targetSeq));
      }
    },
  };
}
