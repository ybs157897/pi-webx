import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import type { AgentSettingsSkill, AgentSettingsUpdate, AgentSettingsView } from '../../../src/shared/module-agent-settings';
import { AGENT_IDS, type AgentId, type ProfileLoadResult, type ResolvedAgentProfile } from '../contracts';
import { loadAgentProfiles } from '../profiles';
import { moduleAgentDefinition } from '../registry';
import { defaultAgentWorkspace, effectiveWorkspace, validateWorkspaceSelection } from '../workspace';
import { planImports } from './imports';
import { replaceFiles } from './persistence';
import { parseUpdate, safePath, SettingsError, skillMetadata } from './validation';

interface Source {
  view: AgentSettingsView;
  profile: ResolvedAgentProfile;
  yaml: string;
}

export interface SettingsServiceOptions {
  /** 仓库层配置根（默认值来源；单根模式下也是写入目标）。 */
  root: string;
  /**
   * 用户层配置根：设置后所有保存都 copy-on-write 到这里，仓库层不再被写入。
   * 加载按「用户层有 `<id>.yaml` 即整体接管该 Agent」的归属规则，见 profiles.ts。
   */
  userRoot?: string;
  profiles: Map<AgentId, ProfileLoadResult>;
  validateModel: (model: { provider: string; id: string }) => Promise<boolean>;
  persist?: typeof replaceFiles;
}

export class ModuleAgentSettingsService {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: SettingsServiceOptions) {}

  /** 该 Agent 当前的归属根：用户层已有同名文件则用户层接管，否则仓库层。 */
  private async owningRoot(id: AgentId): Promise<string> {
    const { root, userRoot } = this.options;
    if (userRoot === undefined) return root;
    try {
      const info = await stat(await safePath(userRoot, `./${id}.yaml`));
      return info.isFile() ? userRoot : root;
    } catch {
      return root;
    }
  }

  /** 读栈与写根：加载按归属（用户层优先接管），保存永远指向用户层。 */
  private loadRoots(): readonly string[] {
    const { root, userRoot } = this.options;
    return userRoot === undefined ? [root] : [userRoot, root];
  }

  private async source(id: AgentId): Promise<Source> {
    const root = await this.owningRoot(id);
    const yamlPath = await safePath(root, `./${id}.yaml`);
    const yaml = await readFile(yamlPath, 'utf8');
    const rawDoc = parseDocument(yaml, { uniqueKeys: true, version: '1.2' });
    if (rawDoc.errors.length) throw new SettingsError(400, 'YAML 无效');
    const raw: unknown = rawDoc.toJS();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsError(400, 'YAML 配置无效');
    const config = raw as Record<string, unknown>;
    if (config.promptFile !== `./prompts/${id}.md` || !Array.isArray(config.skills)) throw new SettingsError(400, '模块资源路径无效');
    const loaded = (await loadAgentProfiles(root)).get(id);
    if (!loaded?.ok) throw new SettingsError(400, '模块配置无效');
    const profile = loaded.profile;
    if (profile.config.promptFile !== `./prompts/${id}.md`) throw new SettingsError(400, '提示词路径必须属于当前模块');
    const promptPath = await safePath(root, profile.config.promptFile);
    const prompt = await readFile(promptPath, 'utf8');
    const entries = profile.config.skillEntries ?? profile.config.skills.map(key => ({ path: key, enabled: true }));
    const skills: AgentSettingsSkill[] = [];
    const contents: [string, string][] = [];
    for (const { path: key, enabled } of entries) {
      const file = await safePath(root, key);
      const content = await readFile(file, 'utf8');
      const meta = skillMetadata(content);
      skills.push({ key, ...meta, selected: enabled, content,
        editable: key.startsWith(`./skills/${id}/`) });
      contents.push([key, content]);
    }
    const names = skills.map(skill => skill.name);
    if (new Set(names).size !== names.length) throw new SettingsError(400, 'Skill 名称重复');
    const revision = createHash('sha256').update(JSON.stringify({ yaml, prompt, contents, profileRevision: profile.profileRevision })).digest('hex');
    return {
      yaml, profile,
      view: {
        id, enabled: profile.config.enabled, implemented: moduleAgentDefinition(id) !== undefined,
        revision, prompt, model: profile.config.model ?? null,
        workspace: profile.config.workspace ?? null,
        workspacePath: effectiveWorkspace(profile), workspaceDefaultPath: defaultAgentWorkspace(id), skills,
      },
    };
  }

  async get(id: AgentId): Promise<AgentSettingsView> {
    await this.pending.catch(() => undefined);
    return (await this.source(id)).view;
  }

  async update(id: AgentId, input: unknown): Promise<AgentSettingsView> {
    const task = this.pending.catch(() => undefined).then(() => this.save(id, parseUpdate(input)));
    this.pending = task;
    return await task;
  }

  private async save(id: AgentId, update: AgentSettingsUpdate): Promise<AgentSettingsView> {
    const before = await this.source(id);
    if (before.view.revision !== update.revision) throw new SettingsError(409, '配置已变化，请重新加载');
    const { profiles, userRoot } = this.options;
    const writeRoot = userRoot ?? this.options.root;
    const migrating = (await this.owningRoot(id)) !== writeRoot;
    if (userRoot !== undefined) {
      // 用户层目录首迁时可能还不存在；safePath 会 lstat 根目录，先建好。
      await mkdir(userRoot, { recursive: true, mode: 0o700 });
    }
    const requestedWorkspace = update.workspace === undefined ? before.view.workspace : update.workspace;
    let workspace: string | null;
    try {
      workspace = await validateWorkspaceSelection(id, requestedWorkspace);
    } catch (error) {
      throw new SettingsError(400, error instanceof Error ? error.message : '工作区路径无效');
    }
    if (update.model && (before.view.model?.provider !== update.model.provider || before.view.model?.id !== update.model.id)) {
      if (!(await this.options.validateModel(update.model))) throw new SettingsError(400, '模型不在当前运行时目录');
    }
    const old = new Map(before.view.skills.map(skill => [skill.key, skill]));
    const submitted = new Map<string, boolean>();
    const changes = new Map<string, string | Buffer>();
    if (migrating) {
      // Copy-on-write 首迁：把该 Agent 的整组资源（YAML、提示词、全部声明的
      // Skill 候选）落到用户层，后续改动全部发生在用户层，仓库层不再被写。
      for (const skill of before.view.skills) {
        changes.set(await safePath(writeRoot, skill.key, true), skill.content);
      }
    }
    const nextNames: string[] = [];
    for (const item of update.skills) {
      if (submitted.has(item.key)) throw new SettingsError(400, 'Skill key 重复');
      if (!old.has(item.key)) throw new SettingsError(400, 'Skill key 未在 YAML 声明');
      const prior = old.get(item.key)!;
      if (item.content !== undefined && item.content !== prior.content && !prior.editable) throw new SettingsError(400, '共享 Skill 不可编辑');
      const content = item.content ?? prior.content;
      nextNames.push(skillMetadata(content).name);
      if (content !== prior.content) changes.set(await safePath(writeRoot, item.key), content);
      submitted.set(item.key, item.selected);
    }
    if (submitted.size !== old.size) throw new SettingsError(400, '必须提交全部 YAML Skill 候选');
    if (new Set(nextNames).size !== nextNames.length) throw new SettingsError(400, 'Skill 名称重复');
    const imported = await planImports(writeRoot, id, update.imports ?? [], nextNames);
    if (old.size + imported.keys.length > 64) throw new SettingsError(400, 'Skill 候选过多');
    for (const [file, bytes] of imported.changes) changes.set(file, bytes);
    const entries = [
      ...(before.profile.config.skillEntries ?? before.profile.config.skills.map(key => ({ path: key, enabled: true }))),
      ...imported.keys.map(key => ({ path: key, enabled: true })),
    ];
    const selected = entries.filter(entry => submitted.get(entry.path)).map(entry => entry.path);
    selected.push(...imported.keys);
    const doc = parseDocument(before.yaml, { uniqueKeys: true, version: '1.2' });
    if (doc.errors.length) throw new SettingsError(400, 'YAML 无效');
    if (update.model) {
      if (before.view.model?.provider !== update.model.provider || before.view.model?.id !== update.model.id) doc.set('model', update.model);
    } else if (before.view.model) doc.delete('model');
    if (workspace === null) {
      if (before.view.workspace !== null) doc.delete('workspace');
    } else if (workspace !== before.view.workspace) doc.set('workspace', workspace);
    if (imported.keys.length || entries.some(entry => entry.enabled !== submitted.get(entry.path))) {
      doc.set('skills', entries.map(entry => (imported.keys.includes(entry.path) || submitted.get(entry.path))
        ? entry.path : { path: entry.path, enabled: false }));
    }
    const tools = before.profile.config.tools.filter(tool => selected.length > 0 || tool !== 'skills.read');
    if (selected.length && !tools.includes('skills.read')) tools.push('skills.read');
    if (JSON.stringify(tools) !== JSON.stringify(before.profile.config.tools)) doc.set('tools', tools);
    changes.set(await safePath(writeRoot, `./${id}.yaml`, migrating), String(doc));
    changes.set(await safePath(writeRoot, `./prompts/${id}.md`, migrating), update.prompt);
    // Recheck disk content immediately before publishing. All module writes share one queue.
    if ((await this.source(id)).view.revision !== update.revision) throw new SettingsError(409, '配置已变化，请重新加载');
    let next: ResolvedAgentProfile | undefined;
    let nextView: AgentSettingsView | undefined;
    await (this.options.persist ?? replaceFiles)(changes, async () => {
      const loaded = await this.source(id);
      next = loaded.profile;
      nextView = loaded.view;
    });
    const reloaded = (await loadAgentProfiles(this.loadRoots())).get(id);
    profiles.set(id, reloaded?.ok ? { ok: true, profile: reloaded.profile } : { ok: true, profile: next! });
    return nextView!;
  }
}

export function isSettingsId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}
