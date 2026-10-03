import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import { getRequirementVersion } from './lifecycle';

type RequirementRecord = Record<string, unknown> & { id: string };

const HOST_APPLICATION = {
  id: 'pi-webx',
  name: 'AI 指挥台',
  entry: '需求助手',
  description: 'AI 指挥台是管理需求、待办、问题、日志、知识和 Agent 协作的工作台。这里的产品事实只描述当前宿主应用。',
  supportedWorkflow: [
    '先澄清用户想处理的对象、目标和范围；“这个”等指代不明确时，不把当前宿主应用当成目标。',
    '围绕已确认的目标整理背景、范围、约束和验收标准，再拆出可审阅的待办草稿。',
    '保存需求草稿后由用户在界面预览；只有用户明确确认导入，才会创建待办。',
    '实施交接需要明确授权；工作台已有记录只能作为工作台记录引用。',
  ],
  modules: [
    { id: 'dashboard', name: '我的主页', description: '工作台概览。' },
    { id: 'assistant', name: '我的助理', description: '记录待办并提出安排建议。' },
    { id: 'fixes', name: '问题修复', description: '登记与跟踪问题。' },
    { id: 'logs', name: '日志查询', description: '检索工作台日志。' },
    { id: 'requirements', name: '需求管理', description: '整理需求草稿并由用户确认导入待办。' },
    { id: 'codes', name: '代码开发', description: '代码开发 Agent 的工作入口。' },
    { id: 'chatroom', name: '内部聊天室', description: '在工作台内进行 Agent 协作。' },
    { id: 'knowledge', name: '知识库', description: '管理工作台知识资料。' },
    { id: 'agent-settings', name: 'Agent 配置', description: '配置工作台 Agent。' },
  ],
} as const;

function requirementRows(store: WorkbenchStore): RequirementRecord[] {
  return store.listRecords('requirements') as RequirementRecord[];
}

function byNewest(rows: RequirementRecord[]): RequirementRecord[] {
  return [...rows].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
}

function statusCounts(rows: RequirementRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (typeof row.status !== 'string' || row.status === '') continue;
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}

function currentVersion(store: WorkbenchStore, id: string): number | null {
  try {
    return getRequirementVersion(store, id) ?? null;
  } catch (error) {
    if (error instanceof WorkbenchInputError && error.status === 404) return null;
    throw error;
  }
}

function summary(store: WorkbenchStore, row: RequirementRecord): Record<string, unknown> {
  const title = typeof row.title === 'string' ? row.title : undefined;
  return {
    id: row.id,
    ...(title === undefined ? {} : { title: title.slice(0, 120), ...(title.length > 120 ? { titleTruncated: true } : {}) }),
    ...(typeof row.status === 'string' ? { status: row.status } : {}),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    currentVersion: currentVersion(store, row.id),
  };
}

/** Curated host facts plus a small public overview; it never reads user files or session data. */
export function buildRequirementsWorkbenchContext(store: WorkbenchStore): Record<string, unknown> {
  const rows = requirementRows(store);
  return {
    hostApplication: HOST_APPLICATION,
    target: {
      kind: 'unspecified',
      id: null,
      name: null,
      source: 'server-binding',
      instruction: '服务端没有预选目标；优先采用本轮或同话题中已明确的对象。只有仍无唯一指代时才澄清。宿主应用本身不能作为用户目标的默认值。',
    },
    dataScope: {
      records: 'requirements.items 中的记录来自当前 AI 指挥台的需求管理。',
      targetRelation: '这些记录只能证明工作台里已有需求；不能据此推断用户指的是 AI 指挥台、某个仓库或其他产品。',
    },
    requirements: {
      total: rows.length,
      statusCounts: statusCounts(rows),
      items: byNewest(rows).slice(0, 5).map(row => summary(store, row)),
      returned: Math.min(rows.length, 5),
      hasMore: rows.length > 5,
    },
  };
}

export { currentVersion as getPublicRequirementVersion };
