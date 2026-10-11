import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Document, parseDocument } from 'yaml';
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
  /** 编辑目标 YAML 文本：用户层覆盖存在则改覆盖，否则改仓库默认（首次保存会新建覆盖）。 */
  yaml: string;
}

export interface SettingsServiceOptions {
  /** 仓库层配置根（默认值来源；单根模式下也是写入目标）。 */
  root: string;
  /**
   * 用户层配置根：设置后保存走**字段级覆盖**——用户层只落与仓库默认不同的字段
   * （model / workspace / skills 选择 / tools）和被改过的提示词、Skill 文件；
   * 提示词与 Skill 按同名文件影子解析，没改过的部分持续跟随仓库演进。
   */
  userRoot?: string;
  profiles: Map<AgentId, ProfileLoadResult>;
  validateModel: (model: { provider: string; id: string }) => Promise<boolean>;
  persist?: typeof replaceFiles;
}

/** 与仓库默认不同的字段面，供 UI 标注「已脱离仓库默认」。 */
const OVERRIDE_FIELDS = ['model', 'workspace', 'prompt', 'skills', 'tools'] as const;

export class ModuleAgentSettingsService {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: SettingsServiceOptions) {}

  /** 读栈与写根：加载按栈优先级合并，保存永远指向用户层。 */
  private loadRoots(): readonly string[] {
    const { root, userRoot } = this.options;
    return userRoot === undefined ? [root] : [userRoot, root];
  }

  /** 仓库默认层（不带覆盖）的 profile，用作字段 diff 的基线。 */
  private async baseProfile(id: AgentId): Promise<ResolvedAgentProfile> {
    const loaded = (await loadAgentProfiles(this.options.root)).get(id);
    if (!loaded?.ok) throw new SettingsError(400, '模块配置无效');
    return loaded.profile;
  }

  /** 栈上第一个存在该相对文件的绝对路径（用户层影子优先）。 */
  private async resolveResource(key: string): Promise<string> {
    for (const root of this.loadRoots()) {
      const candidate = path.join(root, key);
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch { /* 试下一个根 */ }
    }
    return path.join(this.options.root, key);
  }

  private async source(id: AgentId): Promise<Source> {
    const loaded = (await loadAgentProfiles(this.loadRoots())).get(id);
    if (!loaded?.ok) throw new SettingsError(400, '模块配置无效');
    const profile = loaded.profile;
    if (profile.config.promptFile !== `./prompts/${id}.md`) throw new SettingsError(400, '提示词路径必须属于当前模块');
    // configPath 已是「最高优先级持有 <id>.yaml 的根」：有覆盖即覆盖文件，否则仓库默认。
    const yaml = await readFile(profile.configPath, 'utf8');
    const rawDoc = parseDocument(yaml, { uniqueKeys: true, version: '1.2' });
    if (rawDoc.errors.length) throw new SettingsError(400, 'YAML 无效');

    const base = await this.baseProfile(id);
    const entries = profile.config.skillEntries ?? profile.config.skills.map(key => ({ path: key, enabled: true }));
    const skills: AgentSettingsSkill[] = [];
    const contents: [string, string][] = [];
    for (const { path: key, enabled } of entries) {
      const file = await this.resolveResource(key);
      const content = await readFile(await safePath(path.dirname(file), `./${path.basename(file)}`), 'utf8');
      const meta = skillMetadata(content);
      skills.push({ key, ...meta, selected: enabled, content,
        editable: key.startsWith(`./skills/${id}/`) });
      contents.push([key, content]);
    }
    const names = skills.map(skill => skill.name);
    if (new Set(names).size !== names.length) throw new SettingsError(400, 'Skill 名称重复');
    const revision = createHash('sha256').update(JSON.stringify({ yaml, prompt: profile.promptText, contents, profileRevision: profile.profileRevision })).digest('hex');
    const userOverrides = OVERRIDE_FIELDS.filter(field => this.differsFromBase(field, profile, base));
    return {
      yaml, profile,
      view: {
        id, enabled: profile.config.enabled, implemented: moduleAgentDefinition(id) !== undefined,
        revision, prompt: profile.promptText, model: profile.config.model ?? null,
        workspace: profile.config.workspace ?? null,
        workspacePath: effectiveWorkspace(profile), workspaceDefaultPath: defaultAgentWorkspace(id), skills, userOverrides,
      },
    };
  }

  private differsFromBase(
    field: (typeof OVERRIDE_FIELDS)[number],
    merged: ResolvedAgentProfile,
    base: ResolvedAgentProfile,
  ): boolean {
    switch (field) {
      case 'model': return JSON.stringify(merged.config.model) !== JSON.stringify(base.config.model);
      case 'workspace': return (merged.config.workspace ?? null) !== (base.config.workspace ?? null);
      case 'prompt': return merged.promptText !== base.promptText;
      case 'skills': return JSON.stringify(merged.config.skillEntries) !== JSON.stringify(base.config.skillEntries);
      case 'tools': return JSON.stringify(merged.config.tools) !== JSON.stringify(base.config.tools);
    }
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

  /** 恢复仓库默认：清掉该 Agent 在用户层的全部覆盖（YAML、提示词影子、Skill 影子目录）。 */
  async reset(id: AgentId): Promise<AgentSettingsView> {
    const task = this.pending.catch(() => undefined).then(() => this.resetOne(id));
    this.pending = task;
    return await task;
  }

  private async resetOne(id: AgentId): Promise<AgentSettingsView> {
    const { userRoot, profiles } = this.options;
    if (userRoot === undefined) throw new SettingsError(400, '单根模式没有用户层覆盖可恢复');
    const deletes: string[] = [];
    for (const key of [`./${id}.yaml`, `./prompts/${id}.md`]) {
      const file = path.join(userRoot, key);
      try { if ((await stat(file)).isFile()) deletes.push(await safePath(userRoot, key)); } catch { /* 无此文件 */ }
    }
    const skillDir = path.join(userRoot, 'skills', id);
    try {
      for (const entry of await readdir(skillDir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
          const relName = path.relative(skillDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
          deletes.push(await safePath(skillDir, `./${relName}`));
        }
      }
    } catch { /* 无影子 Skill 目录 */ }
    let next: ResolvedAgentProfile | undefined;
    if (deletes.length > 0) {
      await (this.options.persist ?? replaceFiles)(new Map(), async () => {
        const loaded = (await loadAgentProfiles(this.loadRoots())).get(id);
        if (!loaded?.ok) throw new SettingsError(400, '恢复默认后配置不可用');
        next = loaded.profile;
      }, deletes);
    }
    const reloaded = (await loadAgentProfiles(this.loadRoots())).get(id);
    const profile = reloaded?.ok ? reloaded.profile : next;
    if (profile === undefined) throw new SettingsError(400, '配置不可用');
    profiles.set(id, { ok: true, profile });
    return (await this.source(id)).view;
  }

  private async save(id: AgentId, update: AgentSettingsUpdate): Promise<AgentSettingsView> {
    const before = await this.source(id);
    if (before.view.revision !== update.revision) throw new SettingsError(409, '配置已变化，请重新加载');
    const { profiles, userRoot } = this.options;
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

    /* Skill 候选与导入：两种模式共用 */
    const old = new Map(before.view.skills.map(skill => [skill.key, skill]));
    const submitted = new Map<string, boolean>();
    const changedSkillContents = new Map<string, string>();
    const nextNames: string[] = [];
    for (const item of update.skills) {
      if (submitted.has(item.key)) throw new SettingsError(400, 'Skill key 重复');
      if (!old.has(item.key)) throw new SettingsError(400, 'Skill key 未在 YAML 声明');
      const prior = old.get(item.key)!;
      if (item.content !== undefined && item.content !== prior.content && !prior.editable) throw new SettingsError(400, '共享 Skill 不可编辑');
      const content = item.content ?? prior.content;
      nextNames.push(skillMetadata(content).name);
      if (content !== prior.content) changedSkillContents.set(item.key, content);
      submitted.set(item.key, item.selected);
    }
    if (submitted.size !== old.size) throw new SettingsError(400, '必须提交全部 YAML Skill 候选');
    if (new Set(nextNames).size !== nextNames.length) throw new SettingsError(400, 'Skill 名称重复');

    if (userRoot === undefined) return await this.saveLegacy(id, update, workspace, before, submitted, changedSkillContents, nextNames);

    /* ---------------- 用户层 delta 保存 ---------------- */
    const writeRoot = userRoot;
    await mkdir(writeRoot, { recursive: true, mode: 0o700 });
    const base = await this.baseProfile(id);
    const imported = await planImports(writeRoot, id, update.imports ?? [], nextNames);
    if (old.size + imported.keys.length > 64) throw new SettingsError(400, 'Skill 候选过多');
    const entries = [
      ...(before.profile.config.skillEntries ?? before.profile.config.skills.map(key => ({ path: key, enabled: true }))),
      ...imported.keys.map(key => ({ path: key, enabled: true })),
    ];
    const selected = entries.filter(entry => submitted.get(entry.path)).map(entry => entry.path);
    selected.push(...imported.keys);
    const tools = before.profile.config.tools.filter(tool => selected.length > 0 || tool !== 'skills.read');
    if (selected.length && !tools.includes('skills.read')) tools.push('skills.read');

    const changes = new Map<string, string | Buffer>();
    const deletes: string[] = [];
    // 覆盖文档：已有覆盖则在其上续改；首次保存从空文档起步——绝不能从仓库完整
    // yaml 派生，否则未改字段会被一并冻进用户层，仓库演进就穿不透了。
    const overlayFile = await safePath(writeRoot, `./${id}.yaml`, true);
    const userYamlExists = await this.isFile(overlayFile);
    let doc: ReturnType<typeof parseDocument>;
    if (userYamlExists) {
      doc = parseDocument(before.yaml, { uniqueKeys: true, version: '1.2' });
      if (doc.errors.length) throw new SettingsError(400, 'YAML 无效');
    } else {
      doc = new Document() as unknown as ReturnType<typeof parseDocument>;
      doc.commentBefore = ' 用户层覆盖：只写与仓库默认不同的字段；未列字段随 config/agents 默认演进。';
    }

    // model：null 显式回退默认时，若默认本身有 model 需要写 null 盖掉。
    const modelEqualsBase = JSON.stringify(update.model ?? null) === JSON.stringify(base.config.model ?? null);
    if (modelEqualsBase) doc.delete('model');
    else if (update.model) doc.set('model', update.model);
    else if (base.config.model !== undefined) doc.set('model', null);
    else doc.delete('model');

    const workspaceEqualsBase = (workspace ?? null) === (base.config.workspace ?? null);
    if (workspaceEqualsBase) doc.delete('workspace');
    else if (workspace === null) doc.set('workspace', null);
    else doc.set('workspace', workspace);

    const skillsEqualBase = JSON.stringify(entries.map(entry => imported.keys.includes(entry.path) || submitted.get(entry.path)
      ? entry.path : { path: entry.path, enabled: false })) === JSON.stringify(base.config.skillEntries);
    if (skillsEqualBase) doc.delete('skills');
    else doc.set('skills', entries.map(entry => (imported.keys.includes(entry.path) || submitted.get(entry.path))
      ? entry.path : { path: entry.path, enabled: false }));

    if (JSON.stringify(tools) === JSON.stringify(base.config.tools)) doc.delete('tools');
    else doc.set('tools', tools);

    const overlayHasKeys = ['model', 'workspace', 'skills', 'tools'].some(key => doc.has(key));
    if (overlayHasKeys) changes.set(overlayFile, String(doc));
    else if (userYamlExists) deletes.push(overlayFile);

    // 提示词：与仓库默认相同 → 删掉用户影子；不同 → 落影子文件。
    const promptFile = await safePath(writeRoot, `./prompts/${id}.md`, true);
    if (update.prompt !== base.promptText) changes.set(promptFile, update.prompt);
    else if (await this.isFile(promptFile)) deletes.push(promptFile);

    // Skill 正文改动：整目录影子拷贝（SKILL.md + references 等附属文件一起走，
    // skills.read 的相对资源解析才不悬空），再覆盖改后的 SKILL.md。
    for (const [key, content] of changedSkillContents) {
      const owningFile = await this.resolveResource(key);
      const owningDir = path.dirname(owningFile);
      for (const file of await this.listFiles(owningDir)) {
        const relName = path.relative(owningDir, file).split(path.sep).join('/');
        if (relName === 'SKILL.md') continue;
        const rel = `./${path.posix.join(path.posix.dirname(key.slice(2)), relName)}`;
        changes.set(await safePath(writeRoot, rel, true), await readFile(file));
      }
      changes.set(await safePath(writeRoot, key, true), content);
    }
    for (const [file, bytes] of imported.changes) changes.set(file, bytes);

    if (changes.size === 0 && deletes.length === 0) return before.view;
    // Recheck disk content immediately before publishing. All module writes share one queue.
    if ((await this.source(id)).view.revision !== update.revision) throw new SettingsError(409, '配置已变化，请重新加载');
    let nextView: AgentSettingsView | undefined;
    await (this.options.persist ?? replaceFiles)(changes, async () => {
      nextView = (await this.source(id)).view;
    }, deletes);
    const reloaded = (await loadAgentProfiles(this.loadRoots())).get(id);
    if (reloaded?.ok) profiles.set(id, { ok: true, profile: reloaded.profile });
    return nextView!;
  }

  /** 单根（无用户层）模式：保持整文件写回原根的旧语义，供既有门禁 fixture 使用。 */
  private async saveLegacy(
    id: AgentId,
    update: AgentSettingsUpdate,
    workspace: string | null,
    before: Source,
    submitted: Map<string, boolean>,
    changedSkillContents: Map<string, string>,
    nextNames: string[],
  ): Promise<AgentSettingsView> {
    const { root, profiles } = this.options;
    const changes = new Map<string, string | Buffer>();
    for (const [key, content] of changedSkillContents) changes.set(await safePath(root, key), content);
    const imported = await planImports(root, id, update.imports ?? [], nextNames);
    if (before.view.skills.length + imported.keys.length > 64) throw new SettingsError(400, 'Skill 候选过多');
    for (const [file, bytes] of imported.changes) changes.set(file, bytes);
    const entries = [
      ...(before.profile.config.skillEntries ?? before.profile.config.skills.map(key => ({ path: key, enabled: true }))),
      ...imported.keys.map(key => ({ path: key, enabled: true })),
    ];
    const selected = entries.filter(entry => submitted.get(entry.path) || imported.keys.includes(entry.path)).map(entry => entry.path);
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
    changes.set(await safePath(root, `./${id}.yaml`), String(doc));
    changes.set(await safePath(root, `./prompts/${id}.md`), update.prompt);
    // Recheck disk content immediately before publishing. All module writes share one queue.
    if ((await this.source(id)).view.revision !== update.revision) throw new SettingsError(409, '配置已变化，请重新加载');
    let next: ResolvedAgentProfile | undefined;
    let nextView: AgentSettingsView | undefined;
    await (this.options.persist ?? replaceFiles)(changes, async () => {
      const loaded = await this.source(id);
      next = loaded.profile;
      nextView = loaded.view;
    });
    profiles.set(id, { ok: true, profile: next! });
    return nextView!;
  }

  private async isFile(file: string): Promise<boolean> {
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  }

  /** 目录下全部文件的绝对路径（浅层目录遍历，Skill 目录规模很小）。 */
  private async listFiles(directory: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory()) out.push(...await this.listFiles(file));
      else if (entry.isFile()) out.push(file);
    }
    return out;
  }
}

export function isSettingsId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}
