import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentId } from '../contracts';
import type { AgentSettingsImport } from '../../../src/shared/module-agent-settings';
import { safePath, SettingsError, skillMetadata } from './validation';

export interface ImportPlan {
  keys: string[];
  changes: Map<string, Buffer>;
}

/** Browser uploads carry explicit directory bytes; the server never reads an arbitrary host path. */
export async function planImports(root: string, id: AgentId, imports: AgentSettingsImport[], declaredNames: string[]): Promise<ImportPlan> {
  const names = new Set(declaredNames);
  const changes = new Map<string, Buffer>();
  const keys: string[] = [];
  for (const item of imports) {
    const entry = item.files.find(file => file.path === 'SKILL.md')!;
    const bytes = Buffer.from(entry.content, 'base64');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new SettingsError(400, 'SKILL.md 必须是 UTF-8 文本'); }
    const { name } = skillMetadata(content);
    if (names.has(name)) throw new SettingsError(400, `Skill 名称重复：${name}`);
    names.add(name);
    const key = `./skills/${id}/${name}/SKILL.md`;
    const directory = path.dirname(await safePath(root, key, true));
    try {
      await lstat(directory);
      throw new SettingsError(400, `Skill 目录已存在：${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    keys.push(key);
    for (const file of item.files) {
      const absolute = await safePath(root, `./skills/${id}/${name}/${file.path}`, true);
      if (changes.has(absolute)) throw new SettingsError(400, 'Skill 导入路径重复');
      changes.set(absolute, Buffer.from(file.content, 'base64'));
    }
  }
  return { keys, changes };
}
