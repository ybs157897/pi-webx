import { basename } from 'node:path';
import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import { getRequirementVersion } from './lifecycle';

type RequirementRecord = Record<string, unknown> & { id: string };

/** 会话只感知绑定工作空间；服务端不向模型描述宿主应用的任何身份事实。 */
const WORKSPACE_SCOPE = {
  kind: 'bound-directory',
  note: '当前会话绑定一个独立工作空间；文件与检索工具只能访问该目录内的资料。',
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

/** Bounded workspace framing plus a small public overview; it never reads user files or session data. */
export function buildRequirementsWorkbenchContext(
  store: WorkbenchStore,
  workspaceDir: string,
): Record<string, unknown> {
  const rows = requirementRows(store);
  const projectName = basename(workspaceDir) || workspaceDir;
  return {
    workspace: WORKSPACE_SCOPE,
    target: {
      kind: 'bound-project',
      name: projectName,
      path: workspaceDir,
      source: 'server-binding',
      instruction: '当前 Agent 绑定工作区就是本次需求的默认项目目标。目录名只用于标识项目，不代表具体业务背景；事实以绑定工作区内的项目说明和资料为准。只有具体功能或业务规则等需求缺口影响决策时才澄清。',
    },
    dataScope: {
      records: 'requirements.items 中的记录来自本需求库。',
      targetRelation: '这些记录说明已录入的需求事实；它们不能替代项目资料，也不能据此补造项目业务背景。',
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
