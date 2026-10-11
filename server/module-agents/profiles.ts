/**
 * `config/agents/*.yaml` 统一加载器：只扫根目录直接子文件，逐文件独立成败。
 *
 * 一个文件坏掉只让它自己不可用，不拖垮同目录的其他配置——文件名必须是已注册
 * 的 Agent id 且与内容 `id` 一致，未知文件名也按该文件单独报错。配置目录与
 * 相对资源路径的稳定根由调用方给的 `rootDir` 固定，不随进程 cwd 漂移。
 *
 * 两层归属：仓库 `config/agents/` 是随版本走的机器无关默认；用户层
 * `~/.pi-webx/agents/`（`PI_WEBX_USER_CONFIG_DIR` 可覆盖）是设置页的写入目标，
 * 存放本机的模型、工作区与提示词改动。传入根目录数组时按序取第一个拥有
 * `<id>.yaml` 的根——用户层一份完整配置整体接管该 Agent，不做字段级合并。
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
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

/**
 * 用户层配置根：设置页的写入目标，机器相关字段（模型、工作区、提示词改动）的家。
 * 设置为空字符串视为未设置。
 */
export function userAgentsConfigRoot(): string {
  const raw = process.env['PI_WEBX_USER_CONFIG_DIR'];
  if (raw !== undefined && raw.trim().length > 0) {
    if (!path.isAbsolute(raw)) throw new Error('PI_WEBX_USER_CONFIG_DIR 必须是绝对路径');
    return path.resolve(raw);
  }
  return path.join(homedir(), '.pi-webx', 'agents');
}

class ProfileError extends Error {}

export async function loadAgentProfiles(rootDir: string | readonly string[]): Promise<Map<AgentId, ProfileLoadResult>> {
  if (typeof rootDir !== 'string') return await loadAgentProfileStack(rootDir);
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

/**
 * 栈式加载：仓库默认（数组末位）+ 用户层字段覆盖（高位优先）。
 *
 * 用户层的 `<id>.yaml` 是**薄覆盖**，只携带与仓库默认不同的字段（model、
 * workspace、enabled、skills 选择、tools）；提示词与 Skill 文件按「同名文件
 * 高位根优先」逐个影子解析。这样仓库里的提示词/工具/Skill 演进在用户没有
 * 改过的部分持续生效，用户真正改过的部分才被冻结在用户层。
 */
async function loadAgentProfileStack(roots: readonly string[]): Promise<Map<AgentId, ProfileLoadResult>> {
  const results = new Map<AgentId, ProfileLoadResult>();
  for (const id of AGENT_IDS) {
    const owners = await Promise.all(roots.map(root => isFile(path.join(root, `${id}.yaml`))));
    const baseIndex = lastIndexOfTrue(owners);
    if (baseIndex === -1) {
      results.set(id, { ok: false, agentId: id, file: `${id}.yaml`, error: `配置缺失：任何配置根都没有 ${id}.yaml` });
      continue;
    }
    try {
      const baseRoot = roots[baseIndex]!;
      const config = await readConfigFile(path.join(baseRoot, `${id}.yaml`), id);
      // 从低优先级到高优先级逐层套覆盖，最高位（用户层）最后生效。
      for (let index = baseIndex - 1; index >= 0; index -= 1) {
        if (!owners[index]) continue;
        const overlayRoot = roots[index]!;
        const overlay = await readOverlayFile(path.join(overlayRoot, `${id}.yaml`), id);
        applyOverlay(config, overlay);
      }
      const topIndex = owners.indexOf(true);
      const configPath = path.join(roots[topIndex]!, `${id}.yaml`);
      results.set(id, { ok: true, profile: await hydrateProfile(roots, config, configPath) });
    } catch (error) {
      results.set(id, {
        ok: false, agentId: id, file: path.join(roots[0]!, `${id}.yaml`),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // 用户层的未知文件名同样按文件单独报错（拼写错误要响，不能静默忽略）。
  for (const root of roots) {
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
        .map((entry) => entry.name);
    } catch { continue; }
    for (const name of names) {
      const stem = name.slice(0, -'.yaml'.length);
      if ((AGENT_IDS as readonly string[]).includes(stem)) continue;
      results.set(stem as AgentId, {
        ok: false, agentId: null, file: path.join(root, name),
        error: `未知 Agent 配置文件名：${name}（允许：${AGENT_IDS.join('、')}）`,
      });
    }
  }
  return results;
}

function lastIndexOfTrue(flags: readonly boolean[]): number {
  for (let index = flags.length - 1; index >= 0; index -= 1) {
    if (flags[index]) return index;
  }
  return -1;
}

/** 薄覆盖的合法字段：结构性字段（schemaVersion/id）只允许原值出现。 */
const OVERLAY_KEYS = ['schemaVersion', 'id', 'model', 'workspace', 'enabled', 'skills', 'tools'] as const;

interface OverlayFields {
  model?: { provider: string; id: string } | null;
  workspace?: string | null;
  enabled?: boolean;
  skills?: { path: string; enabled: boolean }[];
  tools?: string[];
}

async function readOverlayFile(file: string, id: AgentId): Promise<OverlayFields> {
  const text = await readFile(file, 'utf8');
  const doc = parseDocument(text, { uniqueKeys: true, version: '1.2' });
  if (doc.errors.length > 0) {
    throw new ProfileError(`用户层 ${id}.yaml 解析失败：${doc.errors[0]!.message.split('\n')[0]}`);
  }
  const raw: unknown = doc.toJS();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileError(`用户层 ${id}.yaml 必须是单个 YAML 对象`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(OVERLAY_KEYS as readonly string[]).includes(key)) {
      throw new ProfileError(`用户层 ${id}.yaml 存在非覆盖字段 "${key}"（该字段随仓库默认走）`);
    }
  }
  if (obj.schemaVersion !== undefined && obj.schemaVersion !== 1) throw new ProfileError('用户层 schemaVersion 必须是 1');
  if (obj.id !== undefined && obj.id !== id) throw new ProfileError(`用户层配置 id "${String(obj.id)}" 与文件名 "${id}" 不一致`);
  const overlay: OverlayFields = {};
  if (obj.model !== undefined && obj.model !== null) {
    if (!isObject(obj.model)) failOverlay(id, 'model 必须是对象');
    requireKeys(obj.model, ['provider', 'id'], `用户层 ${id} model `);
    overlay.model = {
      provider: needString(obj.model.provider, `用户层 ${id} model.provider`),
      id: needString(obj.model.id, `用户层 ${id} model.id`),
    };
  } else if (obj.model === null) {
    overlay.model = null; // 显式回退默认模型
  }
  if (obj.workspace !== undefined) {
    if (obj.workspace === null) overlay.workspace = null;
    else {
      const workspace = needString(obj.workspace, `用户层 ${id} workspace`);
      if (!path.isAbsolute(workspace) || workspace.includes('\0')) failOverlay(id, 'workspace 必须是绝对路径');
      overlay.workspace = workspace;
    }
  }
  if (obj.enabled !== undefined) overlay.enabled = needBool(obj.enabled, `用户层 ${id} enabled`);
  if (obj.tools !== undefined) overlay.tools = needStringArray(obj.tools, `用户层 ${id} tools`);
  if (obj.skills !== undefined) {
    if (!Array.isArray(obj.skills)) failOverlay(id, 'skills 必须是数组');
    overlay.skills = (obj.skills as unknown[]).map((item, index) => {
      if (typeof item === 'string') return { path: item, enabled: true };
      if (!isObject(item)) failOverlay(id, `skills[${index}] 必须是路径或对象`);
      requireKeys(item, ['path', 'enabled'], `用户层 ${id} skills[${index}] `);
      return { path: needString(item.path, `用户层 ${id} skills[${index}].path`), enabled: needBool(item.enabled, `用户层 ${id} skills[${index}].enabled`) };
    });
  }
  return overlay;
}

function failOverlay(id: AgentId, message: string): never {
  throw new ProfileError(`用户层 ${id}.yaml：${message}`);
}

function applyOverlay(config: AgentProfileConfig, overlay: OverlayFields): void {
  if (overlay.model === null) delete config.model;
  else if (overlay.model !== undefined) config.model = overlay.model;
  if (overlay.workspace === null) delete config.workspace;
  else if (overlay.workspace !== undefined) config.workspace = overlay.workspace;
  if (overlay.enabled !== undefined) config.enabled = overlay.enabled;
  if (overlay.tools !== undefined) config.tools = [...overlay.tools];
  if (overlay.skills !== undefined) {
    config.skillEntries = overlay.skills.map(entry => ({ ...entry }));
    config.skills = overlay.skills.filter(entry => entry.enabled).map(entry => entry.path);
  }
}

/** 按栈优先级找第一个存在该相对文件的根；都不存在时回落到默认根（读失败会带出明确报错）。 */
function resolveStackFile(roots: readonly string[], relPath: string): string {
  for (const root of roots) {
    const candidate = path.join(root, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(roots[roots.length - 1]!, relPath);
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function loadOne(rootDir: string, name: string): Promise<ResolvedAgentProfile> {
  const file = path.join(rootDir, name);
  const config = await readConfigFile(file, name.slice(0, -'.yaml'.length));
  return await hydrateProfile([rootDir], config, file);
}

/** 读 + 校验一份完整配置（不含资源解析），栈式加载也用它读仓库默认。 */
async function readConfigFile(file: string, stem: string): Promise<AgentProfileConfig> {
  if (!(AGENT_IDS as readonly string[]).includes(stem)) {
    throw new ProfileError(`未知 Agent 配置文件名：${stem}.yaml（允许：${AGENT_IDS.join('、')}）`);
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
  return config;
}

/** 资源水合：提示词与 Skill 按栈优先级逐文件解析，mcp 相对命令锚定默认根。 */
async function hydrateProfile(
  roots: readonly string[],
  config: AgentProfileConfig,
  configPath: string,
): Promise<ResolvedAgentProfile> {
  const baseRoot = roots[roots.length - 1]!;
  for (const entry of config.mcp) {
    if (entry.connection.transport === 'stdio') {
      if (entry.connection.command.startsWith('.')) entry.connection.command = path.resolve(baseRoot, entry.connection.command);
    }
  }
  const promptPath = resolveStackFile(roots, config.promptFile);
  const promptText = await readTextFile(promptPath, `promptFile ${config.promptFile}`);

  const skillPaths: string[] = [];
  for (const skill of config.skills) {
    const skillPath = resolveStackFile(roots, skill);
    await readTextFile(skillPath, `skill ${skill}`);
    skillPaths.push(skillPath);
  }

  const skills = await snapshotSkills(skillPaths);
  const effectiveWorkspace = await captureEffectiveWorkspace(config.id, config.workspace);
  const profile = { config, configPath, effectiveWorkspace, promptText, skillPaths, skills };
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
