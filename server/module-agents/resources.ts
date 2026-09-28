import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export interface SkillSnapshot { name: string; description: string; entry: string; files: Record<string, string> }
export async function snapshotSkills(paths: readonly string[]): Promise<SkillSnapshot[]> {
  const skills: SkillSnapshot[] = [];
  let bytes = 0; let count = 0;
  for (const entry of paths) {
    const root = path.dirname(entry);
    const files: Record<string, string> = {};
    async function visit(dir: string): Promise<void> {
      for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name === '.git' || item.name === 'node_modules') continue;
        if (item.isSymbolicLink()) throw new Error('Skill 资源不允许符号链接');
        const absolute = path.join(dir, item.name);
        if (item.isDirectory()) { await visit(absolute); continue; }
        if (!item.isFile()) continue;
        const data = await readFile(absolute);
        bytes += data.length; count += 1;
        if (bytes > 4_000_000 || count > 256) throw new Error('Skill 快照超过 4MB 或 256 个文件');
        const text = data.toString('utf8');
        if (!Buffer.from(text).equals(data) || text.includes('\0')) throw new Error('Skill 资源仅支持 UTF-8 文本文件');
        files[path.relative(root, absolute).split(path.sep).join('/')] = text;
      }
    }
    await visit(root);
    const entryName = path.basename(entry);
    const content = files[entryName]!;
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) throw new Error(`Skill 缺少 frontmatter：${entry}`);
    const doc = parseDocument(match[1]!, { uniqueKeys: true });
    const meta = doc.toJS() as { name?: unknown; description?: unknown };
    if (doc.errors.length || typeof meta?.name !== 'string' || !meta.name || typeof meta.description !== 'string') throw new Error('Skill 必须声明 name 和 description');
    if (skills.some(skill => skill.name === meta.name)) throw new Error(`同一 Agent 中 Skill 名称重复：${meta.name}`);
    skills.push({ name: meta.name, description: meta.description, entry: entryName, files });
  }
  return skills;
}
export function skillTool(skills: readonly SkillSnapshot[]): ToolDefinition {
  return {
    name: 'skills_read', label: '读取 Agent Skill', description: '按已选 Skill 名读取固定版本正文或其目录内的参考文本；不接受磁盘绝对路径。',
    parameters: Type.Object({ name: Type.String(), resource: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params) {
      const { name, resource } = params as { name: string; resource?: string };
      const skill = skills.find(item => item.name === name);
      const key = resource ?? skill?.entry ?? '';
      const text = skill && Object.hasOwn(skill.files, key) ? skill.files[key] : undefined;
      return { content: [{ type: 'text', text: text ?? 'Skill 或资源不在本 Agent 的固定配置范围内' }], details: { name, resource: key, found: text !== undefined } };
    },
  };
}
export function skillsPrompt(skills: readonly SkillSnapshot[]): string {
  return skills.length ? `可用 Skills（使用 skills_read 按名称读取正文与参考资源）：\n${skills.map(skill => `- ${JSON.stringify(skill.name)}: ${skill.description}`).join('\n')}` : '';
}
