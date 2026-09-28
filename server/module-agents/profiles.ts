/**
 * `config/agents/*.yaml` 统一加载器：只扫根目录直接子文件，逐文件独立成败。
 *
 * 一个文件坏掉只让它自己不可用，不拖垮同目录的其他配置——文件名必须是已注册
 * 的 Agent id 且与内容 `id` 一致，未知文件名也按该文件单独报错。配置目录与
 * 相对资源路径的稳定根由调用方给的 `rootDir` 固定，不随进程 cwd 漂移。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDataSources } from '../data-sources/config';
import { snapshotSkills } from './resources';
import { profileRevision } from './snapshots';
import { captureEffectiveWorkspace } from './workspace';

import { LineCounter, isMap, isScalar, parseDocument } from 'yaml';

import {
  AGENT_IDS,
  type AgentId,
  type AgentProfileConfig,
  type McpConnectionConfig,
  type ProfileLoadResult,
  type ResolvedAgentProfile,
} from './contracts';

/** `<项目根>/config/agents`；项目根从本文件上溯，不读 process.cwd()。 */
export function defaultAgentsConfigRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'agents');
}

class ProfileError extends Error {}

export async function loadAgentProfiles(rootDir: string): Promise<Map<AgentId, ProfileLoadResult>> {
  const results = new Map<AgentId, ProfileLoadResult>();
  let names: string[];
  try {
    names = (await readdir(rootDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    for (const id of AGENT_IDS) {
      results.set(id, {
        ok: false, agentId: id, file: rootDir,
        error: `无法读取配置目录：${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return results;
  }

  const seenIds = new Set<string>();
  for (const name of names) {
    const file = path.join(rootDir, name);
    const stem = name.slice(0, -'.yaml'.length);
    try {
      const profile = await loadOne(rootDir, name);
      if (seenIds.has(profile.config.id)) throw new ProfileError(`重复的 Agent id：${profile.config.id}`);
      seenIds.add(profile.config.id);
      results.set(profile.config.id, { ok: true, profile });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const agentId = (AGENT_IDS as readonly string[]).includes(stem) ? (stem as AgentId) : null;
      results.set(stem as AgentId, { ok: false, agentId, file, error: message });
    }
  }
  return results;
}

async function loadOne(rootDir: string, name: string): Promise<ResolvedAgentProfile> {
  const file = path.join(rootDir, name);
  const stem = name.slice(0, -'.yaml'.length);
  if (!(AGENT_IDS as readonly string[]).includes(stem)) {
    throw new ProfileError(`未知 Agent 配置文件名：${name}（允许：${AGENT_IDS.join('、')}）`);
  }
  const text = await readFile(file, 'utf8');

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: true, version: '1.2', lineCounter });
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    const pos = first.linePos?.[0];
    const where = pos ? `（第 ${pos.line} 行第 ${pos.col} 列）` : '';
    throw new ProfileError(`YAML 解析失败${where}：${first.message.split('\n')[0]}`);
  }
  const raw: unknown = doc.toJS();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileError('配置必须是单个 YAML 对象');
  }
  const config = validateConfig(raw as Record<string, unknown>, doc, lineCounter);
  if (config.id !== stem) {
    throw new ProfileError(`配置 id "${config.id}" 与文件名 "${stem}" 不一致`);
  }

  for (const entry of config.mcp) {
    if (entry.connection.transport === 'stdio') {
      if (entry.connection.command.startsWith('.')) entry.connection.command = path.resolve(rootDir, entry.connection.command);
    }
  }
  const promptPath = path.resolve(rootDir, config.promptFile);
  const promptText = await readTextFile(promptPath, `promptFile ${config.promptFile}`);

  const skillPaths: string[] = [];
  for (const skill of config.skills) {
    const skillPath = path.resolve(rootDir, skill);
    await readTextFile(skillPath, `skill ${skill}`);
    skillPaths.push(skillPath);
  }

  const skills = await snapshotSkills(skillPaths);
  const effectiveWorkspace = await captureEffectiveWorkspace(config.id, config.workspace);
  const profile = { config, configPath: file, effectiveWorkspace, promptText, skillPaths, skills };
  return { ...profile, profileRevision: profileRevision(profile) };
}

async function readTextFile(file: string, label: string): Promise<string> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new ProfileError(`${label} 不是文件：${file}`);
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError(`${label} 缺失或不可读：${file}`);
  }
}

/* ------------------------------------------------------------------ 校验 */

function fail(message: string): never {
  throw new ProfileError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  pos?: (key: string) => string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const at = pos?.(key);
      fail(`${where}存在未知字段 "${key}"${at ? `（${at}）` : ''}`);
    }
  }
}

function needString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') fail(`${field} 必须是非空字符串`);
  return value;
}

function needBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`${field} 必须是布尔值`);
  return value;
}

function needStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${field} 必须是字符串数组`);
  }
  return value as string[];
}

function needPositiveInt(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) fail(`${field} 必须是正整数`);
  return value as number;
}

/** 顶层字段名 → 行列（能定位时）；嵌套字段只报字段名。 */
function topLevelPos(
  doc: ReturnType<typeof parseDocument>,
  lineCounter: LineCounter,
): (key: string) => string {
  return (key) => {
    if (!isMap(doc.contents)) return '';
    for (const item of doc.contents.items) {
      if (isScalar(item.key) && item.key.value === key) {
        const offset = item.key.range?.[0];
        if (offset === undefined) return '';
        const pos = lineCounter.linePos(offset);
        return `第 ${pos.line} 行第 ${pos.col} 列`;
      }
    }
    return '';
  };
}

function validateConfig(
  raw: Record<string, unknown>,
  doc: ReturnType<typeof parseDocument>,
  lineCounter: LineCounter,
): AgentProfileConfig {
  const pos = topLevelPos(doc, lineCounter);
  requireKeys(raw, [
    'schemaVersion', 'id', 'enabled', 'promptFile', 'workspace', 'model',
    'skills', 'tools', 'mcp', 'knowledge', 'limits', 'dataSources',
  ], '顶层 ', pos);

  if (raw.schemaVersion !== 1) fail('schemaVersion 必须是 1');
  if (!(AGENT_IDS as readonly string[]).includes(raw.id as string)) {
    fail(`id 必须是 ${AGENT_IDS.join(' / ')} 之一`);
  }
  const enabled = needBool(raw.enabled, 'enabled');
  const promptFile = needString(raw.promptFile, 'promptFile');
  if (path.isAbsolute(promptFile)) fail('promptFile 必须是相对路径');
  let workspace: string | undefined;
  if (raw.workspace !== undefined && raw.workspace !== null) {
    workspace = needString(raw.workspace, 'workspace');
    if (!path.isAbsolute(workspace) || workspace.includes('\0')) fail('workspace 必须是绝对路径');
  }

  let model: AgentProfileConfig['model'];
  if (raw.model !== undefined) {
    if (!isObject(raw.model)) fail('model 必须是对象');
    requireKeys(raw.model, ['provider', 'id'], 'model ');
    model = { provider: needString(raw.model.provider, 'model.provider'), id: needString(raw.model.id, 'model.id') };
  }

  if (!Array.isArray(raw.skills)) fail('skills 必须是数组');
  const skillEntries = (raw.skills as unknown[]).map((item, index) => {
    let skill: string;
    let enabled: boolean;
    if (typeof item === 'string') { skill = item; enabled = true; }
    else {
      if (!isObject(item)) fail(`skills[${index}] 必须是路径或对象`);
      requireKeys(item, ['path', 'enabled'], `skills[${index}] `);
      skill = needString(item.path, `skills[${index}].path`);
      enabled = needBool(item.enabled, `skills[${index}].enabled`);
    }
    if (!/^\.\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(skill)
      || skill.slice(2).split('/').includes('..') || skill.slice(2).split('/').includes('.')) {
      fail(`skills[${index}] 路径必须是安全的相对路径`);
    }
    if (!skill.endsWith('/SKILL.md')) fail(`skills[${index}] 必须指向 SKILL.md`);
    return { path: skill, enabled };
  });
  if (new Set(skillEntries.map(entry => entry.path)).size !== skillEntries.length) fail('skills 路径不得重复');
  const skills = skillEntries.filter(entry => entry.enabled).map(entry => entry.path);
  const tools = needStringArray(raw.tools, 'tools');

  if (!Array.isArray(raw.mcp)) fail('mcp 必须是数组');
  const mcp = (raw.mcp as unknown[]).map((entry, index) => validateMcp(entry, index));
  if (new Set(mcp.map(entry => entry.id)).size !== mcp.length) fail('MCP id 不得重复');

  if (!isObject(raw.knowledge)) fail('knowledge 必须是对象');
  requireKeys(raw.knowledge, ['homeBinding', 'sharedReadBindings'], 'knowledge ');
  const knowledge = {
    homeBinding: needString(raw.knowledge.homeBinding, 'knowledge.homeBinding'),
    sharedReadBindings: needStringArray(raw.knowledge.sharedReadBindings, 'knowledge.sharedReadBindings'),
  };

  if (!isObject(raw.limits)) fail('limits 必须是对象');
  requireKeys(raw.limits, ['maxRunningSessions', 'maxToolOutputChars'], 'limits ');
  const limits = {
    maxRunningSessions: needPositiveInt(raw.limits.maxRunningSessions, 'limits.maxRunningSessions'),
    maxToolOutputChars: needPositiveInt(raw.limits.maxToolOutputChars, 'limits.maxToolOutputChars'),
  };

  return {
    schemaVersion: 1,
    id: raw.id as AgentId,
    enabled,
    promptFile,
    ...(workspace === undefined ? {} : { workspace }),
    ...(model === undefined ? {} : { model }),
    skills,
    skillEntries,
    dataSources: parseDataSources(raw.dataSources),
    tools,
    mcp,
    knowledge,
    limits,
  };
}

function validateMcp(raw: unknown, index: number): McpConnectionConfig {
  const where = `mcp[${index}]`;
  if (!isObject(raw)) fail(`${where} 必须是对象`);
  requireKeys(raw, ['id', 'enabled', 'required', 'connection', 'tools', 'resources', 'timeoutMs'], `${where} `);
  const id = needString(raw.id, `${where}.id`);
  const enabled = needBool(raw.enabled, `${where}.enabled`);
  const required = needBool(raw.required, `${where}.required`);
  const tools = needStringArray(raw.tools, `${where}.tools`);
  const resources = needBool(raw.resources, `${where}.resources`);
  const timeoutMs = needPositiveInt(raw.timeoutMs, `${where}.timeoutMs`);

  if (!isObject(raw.connection)) fail(`${where}.connection 必须是对象`);
  const conn = raw.connection;
  const transport = conn.transport;
  let connection: McpConnectionConfig['connection'];
  if (transport === 'stdio') {
    requireKeys(conn, ['transport', 'command', 'args', 'cwd', 'envRefs'], `${where}.connection `);
    const command = needString(conn.command, `${where}.connection.command`);
    const args = conn.args === undefined ? undefined : needStringArray(conn.args, `${where}.connection.args`);
    const cwd = conn.cwd === undefined ? undefined : needString(conn.cwd, `${where}.connection.cwd`);
    const envRefs = conn.envRefs === undefined ? undefined : needStringRecord(conn.envRefs, `${where}.connection.envRefs`);
    connection = {
      transport,
      command,
      ...(args === undefined ? {} : { args }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(envRefs === undefined ? {} : { envRefs }),
    };
  } else if (transport === 'streamable-http') {
    requireKeys(conn, ['transport', 'url', 'headerRefs'], `${where}.connection `);
    connection = {
      transport,
      url: needString(conn.url, `${where}.connection.url`),
      ...(conn.headerRefs === undefined ? {} : { headerRefs: needStringRecord(conn.headerRefs, `${where}.connection.headerRefs`) }),
    };
  } else {
    fail(`${where}.connection.transport 必须是 stdio 或 streamable-http`);
  }
  return { id, enabled, required, connection, tools, resources, timeoutMs };
}

function needStringRecord(value: unknown, field: string): Record<string, string> {
  if (!isObject(value)) fail(`${field} 必须是对象（值为环境变量名）`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = needString(item, `${field}.${key}`);
  }
  return out;
}
