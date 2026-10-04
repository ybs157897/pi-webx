import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentId, ResolvedAgentProfile } from './contracts';

const ROOT_ENV = 'PI_WEBX_AGENT_WORKSPACE_ROOT';

export class WorkspaceError extends Error {}

export function defaultAgentWorkspace(id: AgentId): string {
  const root = process.env[ROOT_ENV] ?? path.join(homedir(), '.pi-webx', 'workspaces', 'agents');
  if (!path.isAbsolute(root) || root.includes('\0')) throw new WorkspaceError(`${ROOT_ENV} 必须是绝对路径`);
  return path.join(canonicalCandidateSync(root), id);
}

function canonicalCandidateSync(candidate: string): string {
  const resolved = path.resolve(candidate);
  try { return realpathSync(resolved); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(canonicalCandidateSync(parent), path.basename(resolved));
  }
}

export function effectiveWorkspace(profile: ResolvedAgentProfile): string {
  return profile.effectiveWorkspace ?? profile.config.workspace ?? defaultAgentWorkspace(profile.config.id);
}

// Resolve symlinked ancestors even when the default per-Agent directory does not exist yet.
export async function canonicalWorkspacePath(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  try { return await realpath(resolved); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(await canonicalWorkspacePath(parent), path.basename(resolved));
  }
}

export async function captureEffectiveWorkspace(id: AgentId, custom: string | undefined): Promise<string> {
  const wanted = custom ?? defaultAgentWorkspace(id);
  try { return await canonicalWorkspacePath(wanted); }
  catch { return path.resolve(wanted); }
}

// 不同模块 Agent 允许共享同一个工作区（需求与代码常落在同一项目目录）；
// 这里只做绑定本身的校验（绝对路径、真实目录、可访问），不再比较其他 Agent 的目录。
export async function validateWorkspaceSelection(
  id: AgentId,
  value: string | null,
): Promise<string | null> {
  if (value !== null && (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))) {
    throw new WorkspaceError('工作区必须是绝对路径');
  }
  const wanted = value ?? defaultAgentWorkspace(id);
  if (value !== null) {
    let info;
    try { info = await stat(wanted); await access(wanted, constants.R_OK | constants.X_OK); }
    catch { throw new WorkspaceError('工作区目录不存在或不可访问'); }
    if (!info.isDirectory()) throw new WorkspaceError('工作区必须是现有目录');
  }
  let canonical: string;
  try { canonical = await canonicalWorkspacePath(wanted); }
  catch { throw new WorkspaceError('工作区路径不可访问'); }
  return value === null ? null : canonical;
}

export async function ensureWorkspaceDirectory(directory: string, mayCreate: boolean): Promise<void> {
  if (mayCreate) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) throw new WorkspaceError('工作区不是目录');
    await access(directory, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError('工作区目录不存在或不可访问');
  }
}

/** The SDK cwd is captured by new profiles; old snapshots resume at their stored cwd. */
export async function boundSessionWorkspace(
  profile: ResolvedAgentProfile,
  legacyStoredCwd?: string,
): Promise<string> {
  const captured = profile.effectiveWorkspace;
  if (captured === undefined) {
    const cwd = legacyStoredCwd ?? defaultAgentWorkspace(profile.config.id);
    await ensureWorkspaceDirectory(cwd, legacyStoredCwd === undefined);
    return canonicalWorkspacePath(cwd);
  }
  const selected = profile.config.workspace ?? captured;
  await ensureWorkspaceDirectory(selected, profile.config.workspace === undefined);
  if (await canonicalWorkspacePath(selected) !== captured) {
    throw new WorkspaceError('工作区路径已变化，请重新加载 Agent 配置');
  }
  return captured;
}
