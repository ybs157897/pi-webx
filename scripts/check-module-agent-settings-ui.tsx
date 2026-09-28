import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentSettingsPage, { navigationDecision } from '../src/workbench-app/modules/agent-settings/index.jsx';
import { AgentSettingsActions, AgentSettingsEditor } from '../src/workbench-app/modules/agent-settings/Editor.jsx';
import { agentSettingsApi, AgentSettingsApiError } from '../src/workbench-app/modules/agent-settings/api';
import { api, ApiError } from '../src/lib/api';
import { copyDraft, isDirty, updateBody, validateDraft } from '../src/workbench-app/modules/agent-settings/draft.js';
import { collectSkillImports } from '../src/workbench-app/modules/agent-settings/skill-import.js';
import CommandPalette from '../src/workbench-app/shell/CommandPalette.jsx';
import SettingsSheet from '../src/workbench-app/shell/SettingsSheet.jsx';
import SideNav from '../src/workbench-app/shell/SideNav.jsx';

const own = { key: './skills/logs/log-analysis/SKILL.md', name: 'log-analysis', description: '分析日志', selected: true,
  content: '---\nname: log-analysis\n---\n\n查询日志', editable: true };
const shared = { key: './skills/shared/common/SKILL.md', name: 'common', description: '共享指南', selected: false,
  content: '---\nname: common\n---\n\n共享规则', editable: false };
const view = {
  id: 'logs', enabled: false, implemented: true, revision: 'opaque-revision',
  workspace: null, workspacePath: '/tmp/agent-workspaces/logs', workspaceDefaultPath: '/tmp/agent-workspaces/logs',
  prompt: '日志 Agent 提示词', model: { provider: 'fixture', id: 'model-a' },
  skills: [own, shared],
};
const draft = copyDraft(view);
const catalog = { groups: [{ provider: 'fixture', name: 'Fixture Provider', models: [{ id: 'model-a', name: 'Model A' }] }] };
const callbacks = {
  onModuleChange: () => {}, onEdit: () => {}, onSave: () => {}, onReload: () => {},
  onConfirmPending: () => {}, onCancelPending: () => {},
};

function render(extra: Record<string, unknown> = {}): string {
  const props = {
    id: 'logs', view, draft, loading: false, saving: false, feedback: null,
    errors: {}, catalog, catalogError: '', dirty: false, pending: null,
    ...callbacks, ...extra,
  };
  return renderToStaticMarkup(h('div', {},
    h(AgentSettingsEditor, props),
    props.view && props.draft ? h(AgentSettingsActions, props) : null,
  ));
}

const page = renderToStaticMarkup(h(AgentSettingsPage, {}));
assert.ok(page.includes('data-module="agent-settings"') && page.includes('data-testid="agent-settings-page"'), '真实页面应有模块根');
assert.ok(page.includes('data-testid="agent-settings-loading"'), '页面首屏应显示读取态');
assert.ok(!page.includes('role="dialog"'), '配置入口应是页面');

const markup = render();
for (const testid of [
  'agent-settings-editor', 'agent-settings-module', 'agent-settings-status',
  'agent-settings-prompt-section', 'agent-settings-prompt', 'agent-settings-model-section',
  'agent-settings-model', 'agent-settings-skills', 'agent-settings-skill', 'agent-settings-save',
  'agent-settings-polish', 'agent-settings-skill-import', 'agent-settings-skill-details',
  'agent-settings-workspace-section', 'agent-settings-workspace-default', 'agent-settings-workspace-custom',
  'agent-settings-workspace-path', 'agent-settings-workspace-pick', 'agent-settings-workspace-effective',
]) assert.ok(markup.includes(`data-testid="${testid}"`), `真实编辑器缺少 ${testid}`);
assert.ok(markup.includes('readOnly=""') && markup.includes('选择文件夹'), '工作区路径仅供读取，必须使用系统文件夹选择器');
assert.ok(markup.indexOf('data-testid="agent-settings-workspace-section"') < markup.indexOf('data-testid="agent-settings-prompt-section"'), '工作区应在提示词之前');
assert.ok(markup.includes('/tmp/agent-workspaces/logs') && markup.includes('工作区变更仅对新对话生效'));
assert.ok(markup.includes('role="tablist"') && (markup.match(/role="tab"/g) ?? []).length === 4,
  '模块应呈现四个可访问的卡片 Tab');
assert.equal((markup.match(/data-testid="agent-settings-tab"/g) ?? []).length, 4, '每个模块切换按钮应有 DOM 门禁标识');
assert.ok(markup.includes('role="tabpanel"') && markup.includes('aria-selected="true"'));
for (const copy of [
  '工作助理', '日志', '需求', '代码', '已禁用', '已实现', '系统提示词', '日志 Agent 提示词',
  '跟随默认模型', 'Fixture Provider', 'Model A', own.name, own.description,
  shared.name, shared.description, '已选用', '未选用', '保存后用于新对话，已有对话保持原配置。',
]) assert.ok(markup.includes(copy), `真实编辑器缺少「${copy}」`);
assert.equal((markup.match(/data-testid="agent-settings-skill"/g) ?? []).length, 2, '只显示 fixture 声明的两个候选');
assert.equal((markup.match(/type="checkbox"/g) ?? []).length, 2);
assert.equal((markup.match(/checked=""/g) ?? []).length, 2, '默认工作区与一个 Skill 应被选中');
assert.ok(markup.includes('disabled=""'), '无修改时保存按钮应禁用');
assert.ok(markup.includes('导入 Skill 文件夹') && markup.includes('查看详情') && markup.includes('AI 润色'));
assert.ok(!markup.includes('class="modal-foot"'), '保存按钮应在正常页面布局');
const empty = render({ view: { ...view, skills: [] }, draft: { ...draft, skills: [] } });
assert.ok(empty.includes('data-testid="agent-settings-empty-skills"'));
assert.ok(empty.includes('当前 Agent 未配置 Skill'));

const missing = render({
  view: { ...view, enabled: true, implemented: false },
  draft: { ...draft, model: { provider: 'gone', id: 'old-model' } },
  catalogError: 'catalog fixture failed',
  feedback: { tone: 'error', conflict: true, message: '配置已在别处更新（409）。草稿仍在。' },
  dirty: true,
  pending: { kind: 'navigate', id: 'dashboard' },
});
for (const copy of ['已启用', '尚未实现', '目录中未找到', 'catalog fixture failed', '重新读取并丢弃本地修改',
  '放弃修改', '离开 Agent 配置', '有未保存的修改']) assert.ok(missing.includes(copy), `异常态缺少「${copy}」`);
assert.ok(missing.includes('data-testid="agent-settings-unsaved"'), '离页须显示草稿保护');
assert.ok(missing.includes('role="alertdialog"'), '确认区应有语义角色');
assert.ok(missing.includes('data-testid="agent-settings-keep-editing"'), '确认区应可回到编辑');
assert.ok(missing.includes('data-testid="agent-settings-discard"'), '确认区应可明确放弃');
assert.ok(render({ dirty: true, pending: { kind: 'switch', id: 'codes' } }).includes('切换 Agent'), '切换 Agent 应显示草稿确认');
const worksView = { ...view, id: 'works', enabled: true, prompt: '工作助理独立提示词',
  workspacePath: '/tmp/agent-workspaces/works', workspaceDefaultPath: '/tmp/agent-workspaces/works', skills: [] };
const worksMarkup = render({ id: 'works', view: worksView, draft: copyDraft(worksView) });
assert.ok(worksMarkup.includes('agent-settings-tab-works') && worksMarkup.includes('工作助理独立提示词'));
assert.ok(worksMarkup.includes('/tmp/agent-workspaces/works') && worksMarkup.includes('已启用'));
const invalid = render({ errors: { prompt: '提示词不能为空。' }, dirty: true });
assert.ok(invalid.includes('aria-invalid="true"') && invalid.includes('提示词不能为空。'));
const customWorkspace = render({ view: { ...view, workspace: '/tmp/custom-agent', workspacePath: '/tmp/custom-agent' },
  draft: { ...draft, workspace: '/tmp/new-agent' }, errors: { workspace: '请输入已有工作区的绝对路径。' }, dirty: true });
assert.ok(customWorkspace.includes('value="/tmp/new-agent"') && customWorkspace.includes('请输入已有工作区的绝对路径。'));
assert.ok(customWorkspace.includes('更换文件夹') && customWorkspace.includes('readOnly=""'));
assert.ok(customWorkspace.includes('/tmp/custom-agent') && customWorkspace.includes('/tmp/agent-workspaces/logs'));
const loading = render({ view: null, draft: null, loading: true });
assert.ok(loading.includes('data-testid="agent-settings-loading"'));
assert.ok(!loading.includes('data-testid="agent-settings-prompt"'));
assert.ok(!loading.includes('data-testid="agent-settings-save"'));

assert.equal(isDirty(view, draft), false);
assert.equal(isDirty(view, { ...draft, prompt: '变更' }), true);
assert.equal(isDirty(view, { ...draft, workspace: '/tmp/new-agent' }), true);
assert.equal(isDirty(view, { ...draft, workspace: null }), false, '重置默认工作区应取消工作区草稿差异');
assert.equal(isDirty(view, { ...draft, skills: [{ ...own, selected: false }, shared] }), true);
assert.equal(isDirty(view, { ...draft, skills: [{ ...own, content: own.content + '\n增加内容' }, shared] }), true);
assert.equal(isDirty(view, { ...draft, imports: [{ name: 'sample', files: [{ path: 'SKILL.md', content: 'YWJj' }] }] }), true);
assert.deepEqual(updateBody(view, draft), {
  revision: view.revision, workspace: null, prompt: view.prompt, model: view.model,
  skills: [{ key: own.key, selected: true }, { key: shared.key, selected: false }],
});
assert.ok(validateDraft({ ...draft, prompt: '  ' }).prompt);
assert.ok(validateDraft({ ...draft, workspace: '' }).workspace);
assert.deepEqual(validateDraft({ ...draft, workspace: null }), {});
assert.equal(updateBody(view, { ...draft, workspace: '/tmp/new-agent' }).workspace, '/tmp/new-agent');
const customView = { ...view, workspace: '/tmp/custom-agent', workspacePath: '/tmp/custom-agent' };
assert.equal(isDirty(customView, copyDraft(customView)), false);
assert.equal(isDirty(customView, { ...copyDraft(customView), workspace: null }), true);
assert.equal(updateBody(customView, { ...copyDraft(customView), workspace: null }).workspace, null);
assert.deepEqual(validateDraft(draft), {});
assert.deepEqual(updateBody(view, { ...draft, skills: [{ ...own, content: own.content + '\n新内容' }, shared] }).skills[0],
  { key: own.key, selected: true, content: own.content + '\n新内容' });
assert.equal(navigationDecision({ saving: true, dirty: true, pending: null }), 'blocked');
assert.equal(navigationDecision({ saving: false, dirty: true, pending: null }), 'confirm');
assert.equal(navigationDecision({ saving: false, dirty: false, pending: null }), 'allow');
assert.equal(navigationDecision({ saving: false, dirty: true, pending: { kind: 'switch' } }), 'blocked');

const sheet = renderToStaticMarkup(h(SettingsSheet, {
  open: true, prefs: {}, setPref: () => {}, onExport: () => {}, onImport: () => {},
  onLoadDemo: () => {}, onClearAll: () => {}, onClose: () => {},
}));
assert.ok(!sheet.includes('settings-open-agent-settings') && !sheet.includes('模块 Agent 配置'), '全局设置不应有旧入口');
const appSource = readFileSync(new URL('../src/workbench-app/App.jsx', import.meta.url), 'utf8');
assert.ok(appSource.includes("id: 'agent-settings', label: 'Agent 配置'") && appSource.includes('Component: AgentSettingsPage'), 'App.MODULES 应注册配置页面');
const modules = [
  ...['dashboard', 'tasks', 'works', 'fixes', 'logs', 'requirements', 'codes', 'knowledge']
    .map(id => ({ id, label: id, desc: id, icon: () => h('svg') })),
  { id: 'agent-settings', label: 'Agent 配置', desc: '配置模块 Agent', icon: () => h('svg') },
];
const nav = renderToStaticMarkup(h(SideNav, {
  modules, active: 'agent-settings', data: {}, piStatus: 'idle', onNavigate: () => {},
}));
assert.ok(nav.includes('Agent 配置') && nav.includes('aria-current="page"'), '左侧侧栏应显示并激活配置页');
const palette = renderToStaticMarkup(h(CommandPalette, {
  modules, theme: 'light', onNavigate: () => {}, onOpenSettings: () => {}, onToggleTheme: () => {}, onClose: () => {},
}));
assert.ok(palette.includes('Agent 配置'), '命令面板必须显示第九个模块');
assert.ok(appSource.includes('registerNavigationGuard={registerNavigationGuard}') && appSource.includes('navigationGuard.current?.(id)'), 'App 导航须经过配置页 guard');
assert.ok(appSource.includes('openModule(MODULES[Number(event.key) - 1].id)'), '数字快捷键须经过统一导航');
assert.ok(appSource.indexOf('setDrawerOpen(false)', appSource.indexOf('const openModule')) < appSource.indexOf('navigationGuard.current?.(id)'), '抽屉须在显示离页确认前关闭');
assert.ok(!appSource.includes('agentSettingsOpen') && !appSource.includes('AgentSettingsDialog'), '旧弹窗接线须移除');
const pageSource = readFileSync(new URL('../src/workbench-app/modules/agent-settings/index.jsx', import.meta.url), 'utf8');
assert.ok(pageSource.includes('querySelector(\'#agent-settings-module [role="tab"][aria-selected="true"]\')?.focus()') && pageSource.includes('agent-settings-keep-editing'), '模块 Tab 和未保存确认应管理焦点');
const pageStyle = readFileSync(new URL('../src/workbench-app/modules/agent-settings/styles.css', import.meta.url), 'utf8');
assert.ok(!pageStyle.includes('position: sticky') && !pageStyle.includes('position: fixed'), '页面操作区不得覆盖表单');
assert.ok(pageStyle.includes('.agent-settings-page textarea.agent-settings-prompt { min-height: 360px'), '提示词编辑器要覆盖全局 textarea 的 72px 高度');

const importFile = (name: string, path: string, content: string) => {
  const file = new File([content], name);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
};
const imported = await collectSkillImports([
  importFile('SKILL.md', 'collection/review/SKILL.md', '---\nname: review\ndescription: 检查代码\n---\n规则'),
  importFile('guide.md', 'collection/review/references/guide.md', '辅助资料'),
  importFile('SKILL.md', 'collection/write/SKILL.md', '---\nname: write\ndescription: 写作\n---\n规则'),
]);
assert.deepEqual(imported.map(item => item.name), ['review', 'write']);
assert.deepEqual(imported[0].files.map(file => file.path), ['SKILL.md', 'references/guide.md']);
assert.equal(new TextDecoder().decode(Uint8Array.from(atob(imported[0].files[1].content), char => char.charCodeAt(0))), '辅助资料');

const originalFetch = globalThis.fetch;
try {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init });
    if (init?.method === 'PUT') return new Response(JSON.stringify({ error: 'revision conflict' }), { status: 409 });
    if (init?.method === 'POST') return new Response(JSON.stringify({ prompt: '润色后提示词' }), { status: 200 });
    return new Response(JSON.stringify(view), { status: 200 });
  };
  assert.equal((await agentSettingsApi.read('logs')).revision, view.revision);
  assert.equal(calls[0]?.path, '/api/module-agents/logs/settings');
  await assert.rejects(agentSettingsApi.save('logs', updateBody(view, draft)),
    (error: unknown) => error instanceof AgentSettingsApiError && error.status === 409 && error.message === 'revision conflict');
  assert.equal(calls[1]?.init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), updateBody(view, draft));
  assert.equal(await agentSettingsApi.polish('logs', '原提示词', view.model, new AbortController().signal), '润色后提示词');
  assert.equal(calls[2]?.path, '/api/module-agents/logs/settings/polish');
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { prompt: '原提示词', model: view.model });
} finally {
  globalThis.fetch = originalFetch;
}

try {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init });
    return new Response(JSON.stringify({ path: '/tmp/chosen-agent' }), { status: 200 });
  };
  const controller = new AbortController();
  assert.deepEqual(await api.pickDirectory('/tmp/start', controller.signal), { path: '/tmp/chosen-agent' });
  assert.equal(calls[0]?.path, '/api/workspace/pick');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { initial: '/tmp/start' });
  assert.equal(calls[0]?.init?.signal, controller.signal);

  globalThis.fetch = async () => new Response(JSON.stringify({ path: null }), { status: 200 });
  assert.deepEqual(await api.pickDirectory('/tmp/start'), { path: null }, '系统选择器取消应是正常返回');

  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'unsupported' }), { status: 501 });
  await assert.rejects(api.pickDirectory('/tmp/start'),
    (error: unknown) => error instanceof ApiError && error.status === 501);

  globalThis.fetch = async (_path, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const abort = new AbortController();
  const pending = api.pickDirectory('/tmp/start', abort.signal);
  abort.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.status === 0);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('module agent settings UI: page, native workspace picker, navigation, skills, model, validation and polish payload passed');
