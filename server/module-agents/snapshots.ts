import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedAgentProfile } from './contracts';
import { HostError } from '../pi/host-contract';

export function profileRevision(profile: Pick<ResolvedAgentProfile, 'config' | 'promptText' | 'skills'>): string {
  return createHash('sha256').update(JSON.stringify({ config: profile.config, promptText: profile.promptText, skills: profile.skills })).digest('hex');
}
/** Immutable JSON captures selected source definitions and text resources, never resolved secrets. */
export class ProfileSnapshots {
  constructor(private readonly root: string) {}
  async save(profile: ResolvedAgentProfile): Promise<void> {
    if (profileRevision(profile) !== profile.profileRevision) throw new HostError(409, '配置快照摘要不匹配');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, `${profile.profileRevision}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(profile), { flag: 'wx', mode: 0o600 });
      try { await link(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await this.read(profile.profileRevision); }
    } finally { await rm(temporary, { force: true }); }
  }
  async read(revision: string): Promise<ResolvedAgentProfile> {
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new HostError(409, '会话缺少有效配置快照，请新建对话');
    try {
      const profile = JSON.parse(await readFile(path.join(this.root, `${revision}.json`), 'utf8')) as ResolvedAgentProfile;
      if (!Array.isArray(profile.skills) || profile.profileRevision !== revision || profileRevision(profile) !== revision) throw new Error('digest');
      return profile;
    } catch { throw new HostError(409, '原会话配置快照缺失或损坏；请查看历史并新建对话'); }
  }
}
