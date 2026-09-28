import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import type { AgentSettingsUpdate } from '../../../src/shared/module-agent-settings';

export class SettingsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function relativeKey(value: string): boolean {
  return value.startsWith('./') && value.length > 2 && !/[\\\x00-\x1f\x7f]/.test(value)
    && value.slice(2).split('/').every(segment => segment.length > 0 && segment.length <= 255 && segment !== '.' && segment !== '..');
}

export async function safePath(root: string, key: string, mayCreate = false): Promise<string> {
  if (!relativeKey(key)) throw new SettingsError(400, '资源路径不合法');
  const absolute = path.resolve(root, key);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new SettingsError(400, '资源路径超出配置目录');
  if ((await lstat(root)).isSymbolicLink()) throw new SettingsError(400, '配置目录不允许符号链接');
  let current = path.resolve(root);
  const segments = path.relative(current, absolute).split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new SettingsError(400, '资源路径不允许符号链接');
      if (index < segments.length - 1 && !info.isDirectory()) throw new SettingsError(400, '资源父路径不是目录');
      if (index === segments.length - 1 && !info.isFile()) throw new SettingsError(400, '资源不是文件');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !mayCreate) throw error;
    }
  }
  return absolute;
}

export function skillMetadata(content: string): { name: string; description: string } {
  if (Buffer.byteLength(content) > 500_000 || content.includes('\0')) throw new SettingsError(400, 'Skill 内容过大或包含非法字符');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new SettingsError(400, 'Skill 缺少 YAML frontmatter');
  const doc = parseDocument(match[1]!, { uniqueKeys: true, version: '1.2' });
  if (doc.errors.length || !doc.contents || (doc.contents as { tag?: string }).tag) throw new SettingsError(400, 'Skill frontmatter 无效');
  const meta: unknown = doc.toJS();
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new SettingsError(400, 'Skill frontmatter 必须是对象');
  const { name, description } = meta as Record<string, unknown>;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || typeof description !== 'string' || !description.trim() || description.length > 1000) {
    throw new SettingsError(400, 'Skill 必须有合法 name 和 description');
  }
  return { name, description };
}

export function parseUpdate(input: unknown): AgentSettingsUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SettingsError(400, '请求体必须是对象');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !['revision', 'prompt', 'model', 'workspace', 'skills', 'imports'].includes(key))) throw new SettingsError(400, '请求含未知字段');
  if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw new SettingsError(400, 'revision 无效');
  if (typeof body.prompt !== 'string' || Buffer.byteLength(body.prompt) > 500_000 || body.prompt.includes('\0')) throw new SettingsError(400, 'prompt 无效');
  if (body.model !== null && (typeof body.model !== 'object' || Array.isArray(body.model) || !body.model)) throw new SettingsError(400, 'model 无效');
  if (body.model) {
    const model = body.model as Record<string, unknown>;
    if (Object.keys(model).some(key => !['provider', 'id'].includes(key)) || typeof model.provider !== 'string' || !model.provider || typeof model.id !== 'string' || !model.id) throw new SettingsError(400, 'model 无效');
  }
  if (body.workspace !== undefined && body.workspace !== null
    && (typeof body.workspace !== 'string' || !body.workspace.trim() || body.workspace.length > 4096 || body.workspace.includes('\0'))) {
    throw new SettingsError(400, 'workspace 无效');
  }
  if (!Array.isArray(body.skills) || body.skills.length > 64) throw new SettingsError(400, 'skills 无效');
  for (const item of body.skills) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SettingsError(400, 'Skill 项无效');
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some(key => !['key', 'selected', 'content'].includes(key)) || typeof entry.key !== 'string' || typeof entry.selected !== 'boolean'
      || (entry.content !== undefined && (typeof entry.content !== 'string' || Buffer.byteLength(entry.content) > 500_000 || entry.content.includes('\0')))) {
      throw new SettingsError(400, 'Skill 项无效');
    }
  }
  if (body.imports !== undefined) {
    if (!Array.isArray(body.imports) || body.imports.length > 64) throw new SettingsError(400, 'Skill 导入无效');
    let totalBytes = 0;
    for (const item of body.imports) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SettingsError(400, 'Skill 导入无效');
      const imported = item as Record<string, unknown>;
      if (Object.keys(imported).some(key => key !== 'files') || !Array.isArray(imported.files) || imported.files.length < 1 || imported.files.length > 200) throw new SettingsError(400, 'Skill 文件数无效');
      const seen = new Set<string>();
      for (const file of imported.files) {
        if (!file || typeof file !== 'object' || Array.isArray(file)) throw new SettingsError(400, 'Skill 文件无效');
        const entry = file as Record<string, unknown>;
        if (Object.keys(entry).some(key => !['path', 'content'].includes(key)) || typeof entry.path !== 'string' || typeof entry.content !== 'string'
          || !relativeKey(`./${entry.path}`) || entry.path.split('/').some(segment => segment === '.git' || segment === 'node_modules') || seen.has(entry.path)
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)) {
          throw new SettingsError(400, 'Skill 文件路径或编码无效');
        }
        seen.add(entry.path);
        const bytes = Buffer.from(entry.content, 'base64');
        if (bytes.toString('base64') !== entry.content) throw new SettingsError(400, 'Skill 文件 base64 无效');
        totalBytes += bytes.length;
        if (totalBytes > 4_000_000) throw new SettingsError(400, 'Skill 导入超过 4MB');
      }
      if (!seen.has('SKILL.md')) throw new SettingsError(400, 'Skill 导入缺少根目录 SKILL.md');
    }
  }
  return body as unknown as AgentSettingsUpdate;
}
