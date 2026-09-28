import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAgentsConfigRoot, loadAgentProfiles } from '../server/module-agents/profiles';
import { skillTool } from '../server/module-agents/resources';
import { ModuleAgentSettingsService } from '../server/module-agents/settings/service';
import { replaceFiles } from '../server/module-agents/settings/persistence';
import type { AgentSettingsUpdate, AgentSettingsView } from '../src/shared/module-agent-settings';

const temp = await mkdtemp(join(tmpdir(), 'pi-webx-skill-settings-'));
const root = join(temp, 'agents');
const encode = (value: string | Buffer) => Buffer.from(value).toString('base64');
const body = (view: AgentSettingsView): AgentSettingsUpdate => ({
  revision: view.revision, prompt: view.prompt, model: view.model,
  skills: view.skills.map(({ key, selected }) => ({ key, selected })),
});
const importedSkill = (name: string) => ({ files: [
  { path: 'SKILL.md', content: encode(`---\nname: ${name}\ndescription: Imported method\n---\nDetailed instructions`) },
  { path: 'references/guide.md', content: encode('SUPPORTING-TEXT') },
  { path: 'assets/icon.png', content: encode(Buffer.from([0, 255, 17, 0])) },
] });

try {
  await cp(defaultAgentsConfigRoot(), root, { recursive: true });
  const profiles = await loadAgentProfiles(root);
  const service = new ModuleAgentSettingsService({ root, profiles, validateModel: async () => true });
  const initial = await service.get('logs');
  const priorProfile = profiles.get('logs');
  assert.ok(priorProfile?.ok);
  assert.equal(initial.skills[0]?.editable, true);
  assert.match(initial.skills[0]?.content ?? '', /name: log-analysis/);

  const request = { ...body(initial), imports: [importedSkill('my-lookup')] };
  const added = await service.update('logs', request);
  const key = './skills/logs/my-lookup/SKILL.md';
  assert.equal(added.skills.find(item => item.key === key)?.selected, true);
  assert.equal(added.skills.find(item => item.key === key)?.editable, true);
  assert.equal((await readFile(join(root, 'skills/logs/my-lookup/assets/icon.png'))).toString('hex'), '00ff1100');
  assert.equal(await readFile(join(root, 'skills/logs/my-lookup/references/guide.md'), 'utf8'), 'SUPPORTING-TEXT');
  const active = profiles.get('logs');
  assert.ok(active?.ok);
  assert.notEqual(active.profile.profileRevision, priorProfile.profile.profileRevision);
  const importedSnapshot = active.profile.skills.find(item => item.name === 'my-lookup');
  assert.equal(importedSnapshot?.files['references/guide.md'], 'SUPPORTING-TEXT');
  assert.equal(importedSnapshot?.binaryFiles?.['assets/icon.png'], encode(Buffer.from([0, 255, 17, 0])));
  const binaryResult = await skillTool(active.profile.skills).execute('binary', { name: 'my-lookup', resource: 'assets/icon.png' }, undefined, undefined, {} as never);
  assert.equal(binaryResult.details?.binary, true);
  assert.match(JSON.stringify(binaryResult.content), /二进制/);
  const reread = await service.get('logs');
  assert.equal(reread.revision, added.revision, 'saved view must match disk');

  const edited = body(added);
  const selected = edited.skills.find(item => item.key === key)!;
  selected.content = '---\nname: renamed-lookup\ndescription: Revised method\n---\nRevised instructions';
  const revised = await service.update('logs', edited);
  assert.equal(revised.skills.find(item => item.key === key)?.name, 'renamed-lookup');
  assert.equal(revised.skills.find(item => item.key === key)?.description, 'Revised method');
  assert.match(await readFile(join(root, 'skills/logs/my-lookup/SKILL.md'), 'utf8'), /Revised instructions/);
  const revisedProfile = profiles.get('logs');
  assert.ok(revisedProfile?.ok);
  assert.notEqual(revisedProfile.profile.profileRevision, active.profile.profileRevision);
  await assert.rejects(() => service.update('logs', edited), /配置已变化/);
  assert.equal((await service.get('logs')).revision, revised.revision);

  await writeFile(join(root, 'codes.yaml'), (await readFile(join(root, 'codes.yaml'), 'utf8'))
    .replace('skills: []', `skills:\n  - ${key}`));
  const codeView = await service.get('codes');
  assert.equal(codeView.skills[0]?.editable, false);
  assert.match(codeView.skills[0]?.content ?? '', /Revised instructions/);
  const foreignEdit = body(codeView);
  foreignEdit.skills[0]!.content = '---\nname: stolen\ndescription: unauthorized\n---\nno';
  await assert.rejects(() => service.update('codes', foreignEdit), /共享 Skill 不可编辑/);
  assert.equal((await service.get('codes')).revision, codeView.revision);

  const duplicate = { ...body(revised), imports: [importedSkill('renamed-lookup')] };
  await assert.rejects(() => service.update('logs', duplicate), /名称重复/);
  await mkdir(join(root, 'skills/logs/occupied'));
  await assert.rejects(() => service.update('logs', { ...body(revised), imports: [importedSkill('occupied')] }), /目录已存在/);
  await symlink(join(root, 'skills/codes'), join(root, 'skills/logs/linked'));
  await assert.rejects(() => service.update('logs', { ...body(revised), imports: [importedSkill('linked')] }), /符号链接/);
  for (const files of [
    [{ path: '../escape.txt', content: encode('escape') }, importedSkill('bad-path').files[0]!],
    [{ path: 'SKILL.md', content: '$$$' }],
    [{ path: 'SKILL.md', content: encode('---\nname: bad\ndescription: bad\n---\n') }, { path: '.git/config', content: encode('bad') }],
  ]) {
    await assert.rejects(() => service.update('logs', { ...body(revised), imports: [{ files }] }));
  }
  assert.equal((await service.get('logs')).revision, revised.revision);

  const rollbackProfiles = await loadAgentProfiles(root);
  const oldProfile = rollbackProfiles.get('logs');
  const yamlBefore = await readFile(join(root, 'logs.yaml'));
  const promptBefore = await readFile(join(root, 'prompts/logs.md'));
  const skillBefore = await readFile(join(root, 'skills/logs/my-lookup/SKILL.md'));
  const rollback = new ModuleAgentSettingsService({ root, profiles: rollbackProfiles, validateModel: async () => true,
    persist: (changes, validate) => replaceFiles(changes, async () => { await validate(); throw new Error('simulated publication failure'); }),
  });
  const failing = { ...body(await rollback.get('logs')), imports: [importedSkill('rollback-skill')] };
  failing.prompt += '\nROLLBACK SENTINEL';
  failing.skills.find(item => item.key === key)!.content = '---\nname: renamed-lookup\ndescription: Rollback edit\n---\nFAIL';
  await assert.rejects(() => rollback.update('logs', failing), /simulated publication failure/);
  assert.deepEqual(await readFile(join(root, 'logs.yaml')), yamlBefore);
  assert.deepEqual(await readFile(join(root, 'prompts/logs.md')), promptBefore);
  assert.deepEqual(await readFile(join(root, 'skills/logs/my-lookup/SKILL.md')), skillBefore);
  assert.equal((await readdir(join(root, 'skills/logs'))).includes('rollback-skill'), false);
  assert.equal(rollbackProfiles.get('logs'), oldProfile);
  assert.equal((await rollback.get('logs')).revision, failing.revision);
  console.log('PASS 模块 Skill 设置：导入完整目录与二进制、正文/元数据编辑、模块只读隔离、冲突与原子回滚');
} finally {
  await rm(temp, { recursive: true, force: true });
}
