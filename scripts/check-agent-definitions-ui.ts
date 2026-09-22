/**
 * 子智能体设置页的钉子：表单规则 + 一次真实组件渲染。
 *
 * 前半是纯函数断言——默认值、脏检查、边界、patch 变换、409 草稿保留。这些规则
 * 都属于"点了才知道"的那一类：默认工具模式错了会让新子智能体默认拿不到工具或
 * 默认拿到过多；409 丢草稿会让用户白写一屏提示词；指定模型没选全就提交会把一个
 * 必然解析失败的模型写进配置。所以它们留在 `agent-definitions-form.ts` 里被这里
 * 钉住，而不是埋在组件的 state 里只能靠点。
 *
 * 后半用组件做一次最小 bootstrap 渲染：确认该 section 能在 Node 里真的挂起来
 * （真实 React + 真实 CSS Module 代理），而不是只通过类型检查。渲染发生在
 * effect 之外，三份网络读取不会发出，因此这里**不**涉及服务、模型或浏览器。
 *
 * 用法：`node --import ./scripts/check-bootstrap.mjs scripts/check-agent-definitions-ui.ts`
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentDefinitionsSection } from '../src/components/settings/AgentDefinitionsSection';
import {
  AGENT_COLOR_LABELS,
  AGENT_COLOR_ORDER,
  AGENT_MAX_CONCURRENT_RANGE,
  AGENT_MAX_TURNS_RANGE,
  AGENT_NAME_PATTERN,
  addToolName,
  agentDefinitionCounts,
  agentFormValuesFromDefinition,
  agentNameKey,
  clearToolNames,
  createAgentFormValues,
  createInputFromValues,
  decodeModelSelection,
  encodeModelSelection,
  initialSelectedToolsForCustom,
  groupAgentDefinitions,
  isAgentFormDirty,
  marksUnavailableModel,
  modelSelectionValue,
  MAX_SELECTED_TOOLS,
  normalizeAgentName,
  patchFromValues,
  reconcileConflict,
  removeToolName,
  selectAllToolNames,
  selectedToolNames,
  textLength,
  toggleAgentColor,
  validateAgentForm,
  type AgentFormValues,
} from '../src/components/settings/agent-definitions-form';
import {
  DEFAULT_AGENT_MAX_CONCURRENT_INSTANCES,
  DEFAULT_AGENT_MAX_TURNS,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_NAME_LENGTH,
  MAX_AGENT_PROMPT_LENGTH,
  MIN_AGENT_NAME_LENGTH,
  SUBAGENT_COLORS,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentDefinitionPatch,
} from '../src/shared/agent-definitions';

/* ------------------------------------------------------------------ defaults */

const blank = createAgentFormValues();

// 新定义默认「全部工具」——`all` 是 "父当前可用的全部"，不是 "系统里存在的全部"；
// 默认写成 selected 会让新子智能体默认只能推理，默认写成自定义空列表更糟。
assert.equal(blank.toolsMode, 'all', '默认工具模式必须是「全部可用工具」');
assert.deepEqual(selectedToolNames(blank), [], '默认 all 模式下不应有勾选项');
assert.equal(blank.modelMode, 'inherit', '默认模型必须是继承当前对话');
assert.equal(blank.enabled, false, '新增默认关闭：未启用的定义不应被自动调用');
assert.equal(blank.maxTurns, DEFAULT_AGENT_MAX_TURNS, '默认轮数契约变了');
assert.equal(
  blank.maxConcurrentInstances,
  DEFAULT_AGENT_MAX_CONCURRENT_INSTANCES,
  '默认并发契约变了',
);
assert.equal(
  isAgentFormDirty(blank, undefined),
  false,
  '空白表单配「无原定义」必须是干净的：否则一打开新增就提示未保存',
);

/* ------------------------------------------------- default all ⇒ valid agent */

const named = { ...blank, name: '代码审查', description: '审查改动', systemPrompt: '只审查，不改代码' };
const namedProblems = validateAgentForm(named);
assert.deepEqual(namedProblems.errors, [], `默认 all + 已填必填项应可直接保存：${namedProblems.errors}`);
assert.deepEqual(
  createInputFromValues(named).tools,
  { mode: 'all' },
  '默认工具模式必须序列化成 {mode:"all"}，不能退化成空的自定义列表',
);
assert.equal(createInputFromValues(named).enabled, false, '序列化保留了默认的未启用状态');

/* -------------------------------------------------- 空的自定义工具列表合法 */

const pureReasoning = { ...named, toolsMode: 'selected' as const, selectedTools: [], extraTools: [] };
const pureProblems = validateAgentForm(pureReasoning);
assert.deepEqual(pureProblems.errors, [], 'selected + 空列表必须合法（纯推理子智能体）');
assert.ok(
  pureProblems.warnings.some((text) => text.includes('只能推理')),
  '空勾选要给出「只能推理」的提醒，而不是当成校验错误',
);
assert.deepEqual(
  createInputFromValues(pureReasoning).tools,
  { mode: 'selected', names: [] },
  '空列表必须原样落到 name 列表，不能被悄悄替换成 all',
);

/* -------------------------------------------------------- 中文名称与去重键 */

assert.equal(normalizeAgentName('  代码审查  '), '代码审查', '中文名称应被 trim 后保留');
assert.equal(agentNameKey('Code-Reviewer'), agentNameKey('code-reviewer'), '重名判定必须不区分大小写');
assert.equal(agentNameKey('Ａｇｅｎｔ'), agentNameKey('Agent'), 'NFKC 应把全角折成半角');
assert.deepEqual(
  validateAgentForm({ ...named, name: '  代码审查  ' }).errors,
  [],
  '两边带空格的中文名应视为已填写',
);

const chineseName = createInputFromValues({ ...named, name: '  代码审查  ' }).name;
assert.equal(chineseName, '代码审查', '提交前必须 trim（服务端按 trim 后的长度判界）');

/* ------------------------------------------------------ 固定模型未选全阻止保存 */

const fixedNoProvider = { ...named, modelMode: 'fixed' as const, providerId: '', modelId: '' };
const fixedProblems = validateAgentForm(fixedNoProvider);
assert.ok(
  fixedProblems.errors.some((text) => text.includes('提供方')),
  '指定模型但未选提供方必须阻止保存',
);
assert.ok(
  fixedProblems.errors.some((text) => text.includes('模型')),
  '指定模型但未选模型必须阻止保存',
);

const fixedHalf = { ...named, modelMode: 'fixed' as const, providerId: 'p', modelId: '' };
const halfProblems = validateAgentForm(fixedHalf);
assert.equal(halfProblems.errors.length, 1, `选了提供方但没选模型应只报缺失的那一项：${halfProblems.errors}`);
assert.ok(halfProblems.errors[0]!.includes('模型'), '半选时必须指出缺少模型');
assert.deepEqual(
  validateAgentForm({ ...named, modelMode: 'fixed' as const, providerId: 'p', modelId: 'm' }).errors,
  [],
  '选全的固定模型应可保存',
);

/* ---------------------------------------------------------------- 边界校验 */

/* 名称规则改为 ZCode 的 3..50（文案逐字取自 zh-CN:3375-3376），但字符类放宽为
   Unicode 字母/数字/连字符，因此中文名合法。 */
assert.equal(MIN_AGENT_NAME_LENGTH, 3, '名称下限必须是 3');
assert.equal(MAX_AGENT_NAME_LENGTH, 50, '名称上限必须是 50（ZCode SubagentsSection.tsx:893）');
assert.match('代码审查', AGENT_NAME_PATTERN, '中文名必须被接受');
assert.match('code-reviewer', AGENT_NAME_PATTERN, 'ASCII 连字符名必须被接受');
assert.doesNotMatch('code reviewer', AGENT_NAME_PATTERN, '空格名必须被拒绝');
assert.doesNotMatch('code_reviewer', AGENT_NAME_PATTERN, '下划线必须被拒绝（ZCode 只允许字母数字连字符）');

const nameTooLong = { ...named, name: 'x'.repeat(MAX_AGENT_NAME_LENGTH + 1) };
assert.ok(
  validateAgentForm(nameTooLong).errors.some((t) => t.includes('长度必须在')),
  `超长名称必须报长度错误：${validateAgentForm(nameTooLong).errors}`,
);
assert.deepEqual(
  validateAgentForm({ ...named, name: 'x'.repeat(MAX_AGENT_NAME_LENGTH) }).errors,
  [],
  '名称恰好到上限必须通过（上限包含在内）',
);
assert.ok(
  validateAgentForm({ ...named, name: 'xx' }).errors.some((t) => t.includes('长度必须在')),
  '短于下限的名称必须报长度错误',
);
assert.deepEqual(
  validateAgentForm({ ...named, name: 'abc' }).errors,
  [],
  '恰好 3 个字符必须通过（下限包含在内）',
);
assert.ok(
  validateAgentForm({ ...named, name: '代码 审查' }).errors.some((t) => t.includes('仅允许使用')),
  '含空格的名称必须报字符类错误',
);
/* 错误文案逐字对齐 ZCode。 */
assert.ok(
  validateAgentForm({ ...named, name: 'x'.repeat(51) }).errors.includes('长度必须在 3 到 50 个字符之间'),
  '长度错误文案必须逐字等于 ZCode 的「长度必须在 3 到 50 个字符之间」',
);
assert.ok(
  validateAgentForm({ ...named, name: 'a b' }).errors.includes('仅允许使用字母、数字和连字符'),
  '字符类错误文案必须逐字等于 ZCode 的「仅允许使用字母、数字和连字符」',
);

assert.ok(
  validateAgentForm({ ...named, description: 'x'.repeat(MAX_AGENT_DESCRIPTION_LENGTH + 1) }).errors.length > 0,
  '超长描述必须报错',
);
assert.ok(
  validateAgentForm({ ...named, systemPrompt: 'x'.repeat(MAX_AGENT_PROMPT_LENGTH + 1) }).errors.length > 0,
  '超长系统提示必须报错',
);

/* ------------------------------------------------ 长度按 code point 计（F1） */

/* 服务端用 `[...value].length` 计长度，UI 曾经用 `String.length`（UTF-16 单元）。
   星光面字符（如 CJK 扩展 B 的 U+20000）是 1 个 code point / 2 个 UTF-16 单元，
   于是 50 个这样的字符（50/100）会被旧的 UTF-16 口径误判超限，而服务端接受。 */
const astral = (count: number): string => '\u{20000}'.repeat(count);
/* 描述与系统提示词没有字符类限制，用 emoji 验证它们的 code-point 口径。 */
const emoji = (count: number): string => '🙂'.repeat(count);

assert.equal(astral(50).length, 100, '前提：星光面字符的 UTF-16 长度是 code point 的两倍');
assert.equal(textLength(astral(50)), 50, 'textLength 必须按 code point 计数');
assert.equal(astral(50).length, 2 * textLength(astral(50)), '前提：两种口径恰好差一倍');
assert.match(astral(3), AGENT_NAME_PATTERN, '星光面 CJK 字符属于 \\p{L}，必须被名称字符类接受');

assert.deepEqual(
  validateAgentForm({ ...named, name: astral(50) }).errors,
  [],
  '50 个星光面字符（50 code point / 100 UTF-16）必须通过——UTF-16 口径会误报 100 超限，这正是 F1 的症状',
);
assert.ok(
  validateAgentForm({ ...named, name: astral(51) }).errors.some((t) => t.includes('长度')),
  '51 个星光面字符（超上限）必须被拒',
);

/* 中文字符是 1 个 code point / 1 个 UTF-16 单元，同样必须按 code point 计。 */
assert.deepEqual(
  validateAgentForm({ ...named, name: '代'.repeat(MAX_AGENT_NAME_LENGTH) }).errors,
  [],
  `恰好 ${MAX_AGENT_NAME_LENGTH} 个中文字必须通过`,
);
assert.ok(
  validateAgentForm({ ...named, name: '代'.repeat(MAX_AGENT_NAME_LENGTH + 1) }).errors.length > 0,
  `${MAX_AGENT_NAME_LENGTH + 1} 个中文字必须被拒`,
);

for (const [field, max, label] of [
  ['description', MAX_AGENT_DESCRIPTION_LENGTH, '描述'],
  ['systemPrompt', MAX_AGENT_PROMPT_LENGTH, '系统提示'],
] as const) {
  assert.deepEqual(
    validateAgentForm({ ...named, [field]: emoji(max) }).errors,
    [],
    `${label}：恰好 ${max} 个 code point 必须通过`,
  );
  assert.ok(
    validateAgentForm({ ...named, [field]: emoji(max + 1) }).errors.some((t) => t.includes(label)),
    `${label}：${max + 1} 个 code point 必须被拒`,
  );
}

/* 混合文本（CJK 扩展 B 也在星光面）同样按 code point 计。 */
const astralChars = '\u{20000}'.repeat(3);
assert.equal(astralChars.length, 6, '前提：星光面字符的 UTF-16 长度是 2');
assert.equal(textLength(astralChars), 3, '星光面字符必须计 1 个 code point');

/* 最大轮数与并发上限在 1:1 复刻后**不再渲染**（用户已拍板），因此表单不再对本
   用户看不见的字段报错 —— 校验它们是服务端的事。这里钉的是另一半：它们必须原样
   穿过草稿与 patch，绝不因为「没渲染」而被重置成默认值。 */
for (const hidden of [AGENT_MAX_TURNS_RANGE.min - 1, AGENT_MAX_TURNS_RANGE.max + 1, 7.5]) {
  assert.deepEqual(
    validateAgentForm({ ...named, maxTurns: hidden }).errors,
    [],
    `未渲染的 maxTurns=${hidden} 不该由表单拦下（字段不可见，用户无从修正）`,
  );
}
for (const hidden of [AGENT_MAX_CONCURRENT_RANGE.min - 1, AGENT_MAX_CONCURRENT_RANGE.max + 1, 0]) {
  assert.deepEqual(
    validateAgentForm({ ...named, maxConcurrentInstances: hidden }).errors,
    [],
    `未渲染的 maxConcurrentInstances=${hidden} 不该由表单拦下`,
  );
}

/* ------------------------------------------------- 工具数量上限 128（F4） */

/* 服务端 `tools.names` 上限 128 项，UI 之前完全没镜像 → 129 项时表单无错、保存
   才 400。名字用**手动输入**构造，既覆盖手输路径也避免依赖工具目录。 */
const manualTools = (count: number): string[] => Array.from({ length: count }, (_, i) => `mcp__x__t${i}`);

const atCap = {
  ...pureReasoning,
  extraTools: manualTools(MAX_SELECTED_TOOLS),
};
assert.equal(selectedToolNames(atCap).length, MAX_SELECTED_TOOLS, '前提：构造了恰好 128 个工具名');
assert.deepEqual(
  validateAgentForm(atCap).errors,
  [],
  `恰好 ${MAX_SELECTED_TOOLS} 项必须通过`,
);

const overCap = { ...pureReasoning, extraTools: manualTools(MAX_SELECTED_TOOLS + 1) };
const overCapProblems = validateAgentForm(overCap);
assert.ok(
  overCapProblems.errors.some((t) => t.includes(String(MAX_SELECTED_TOOLS))),
  `第 ${MAX_SELECTED_TOOLS + 1} 项必须报错且指明上限`,
);
assert.equal(
  overCapProblems.errors.length,
  1,
  `超限只应报一条：${overCapProblems.errors}`,
);

/* 上限管的是**去重后**的实际落盘项数，不是 raw 数组长度。 */
const withDuplicates = { ...pureReasoning, extraTools: [...manualTools(MAX_SELECTED_TOOLS), 'mcp__x__t0'] };
assert.equal(selectedToolNames(withDuplicates).length, MAX_SELECTED_TOOLS, '前提：重复项被去重');
assert.deepEqual(
  validateAgentForm(withDuplicates).errors,
  [],
  '重复项去重后仍有 128 项，不该因为 raw 长度 129 而报错',
);

/* 超限是 error 而不是 warning：保存必然 400，拦在能看见的位置。 */
assert.equal(
  validateAgentForm(overCap).warnings.some((t) => t.includes('只能推理')),
  false,
  '超限时不该再叠加「未选择任何工具」的提醒',
);
assert.deepEqual(
  validateAgentForm(overCap).errors.length > 0,
  true,
  '超限必须是 error，不能只是 warning',
);
assert.deepEqual(
  validateAgentForm(pureReasoning).errors,
  [],
  '空 [] 仍然合法（纯推理）',
);
assert.deepEqual(
  validateAgentForm({ ...pureReasoning, toolsMode: 'all' }).errors,
  [],
  'all 模式不受 128 项限制约束',
);



/* ============================ 模型下拉的 JSON tuple codec（task-41 TC3） ====
   症状：option value 是 `provider + '/' + modelId`，解析却用 `split('/')`。
   当 modelId 自身含 `/`（本目录唯一模型 `deepseek/deepseek-v4.1-flash` 就是），
   值被截成 modelId='deepseek'，保存发错模型 → 400，功能不可用。
   下面不只测 codec 本身，而是走完整条真实链路：
     option value → decode（即 select 的 onChange）→ draft → create/patch 的 JSON。
   ---------------------------------------------------------------------------- */

/** 一个 baseline（已存在、fixed 模型），用来产 patch。这里不引用后面的 `stored`，
    好让 codec 用例可以独立于文件顺序。 */
const fixedStored: AgentDefinition = {
  id: 'codec-baseline',
  revision: 1,
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  name: 'codec 基线',
  description: '用于模型下拉 codec 的基线定义',
  systemPrompt: 'baseline',
  model: { mode: 'fixed', providerId: 'p0', modelId: 'm0' },
  tools: { mode: 'all' },
  maxTurns: 8,
  maxConcurrentInstances: 1,
  enabled: false,
};

/* 隐藏字段的往来：读入 → 不改动 → patch 里不出现。 */
const hiddenStored: AgentDefinition = {
  ...fixedStored,
  maxTurns: 17,
  maxConcurrentInstances: 3,
};
const hiddenDraft = agentFormValuesFromDefinition(hiddenStored);
assert.equal(hiddenDraft.maxTurns, 17, '读入必须沿用已存的 maxTurns');
assert.equal(hiddenDraft.maxConcurrentInstances, 3, '读入必须沿用已存的并发上限');
assert.equal(
  isAgentFormDirty(hiddenDraft, hiddenStored),
  false,
  '回填后的草稿必须是干净的（隐藏字段也算）',
);
assert.deepEqual(
  patchFromValues(hiddenDraft, hiddenStored),
  {},
  '完全未改动时必须产出空 patch，隐藏字段不得出现',
);
assert.equal(
  Object.hasOwn(patchFromValues(hiddenDraft, hiddenStored), 'maxTurns'),
  false,
  'patch 不得包含 maxTurns（未渲染字段永不改变）',
);
assert.equal(
  Object.hasOwn(patchFromValues(hiddenDraft, hiddenStored), 'maxConcurrentInstances'),
  false,
  'patch 不得包含 maxConcurrentInstances',
);
assert.deepEqual(
  patchFromValues({ ...hiddenDraft, description: '改了描述' }, hiddenStored),
  { description: '改了描述' },
  '只改可见字段时，patch 只能有那一个字段——隐藏字段必须原样保留',
);
assert.equal(
  createInputFromValues(hiddenDraft).maxTurns,
  17,
  '新建/另存时也必须带上草稿里的 maxTurns',
);
/* 只有草稿本身被改成别的值（不是本表单的路径）才会发出，说明比较逻辑还在。 */
assert.equal(
  patchFromValues({ ...hiddenDraft, maxTurns: 20 }, hiddenStored).maxTurns,
  20,
  '若上游显式改了隐藏字段，patch 仍应如实发出',
);


/**
 * 模拟"用户在下拉里选中了某一项"之后，表单会发出什么。
 * @param optionValue - 真实 `<option value>`，来自 encodeModelSelection。
 */
function pickModelInForm(optionValue: string): {
  decoded: { providerId: string; modelId: string };
  created: AgentDefinitionInput;
  patched: AgentDefinitionPatch;
} {
  const decoded = decodeModelSelection(optionValue);
  const draft: AgentFormValues = {
    ...agentFormValuesFromDefinition(fixedStored),
    modelMode: 'fixed',
    providerId: decoded.providerId,
    modelId: decoded.modelId,
  };
  return {
    decoded,
    created: createInputFromValues(draft),
    patched: patchFromValues(draft, fixedStored),
  };
}

/* 每个用例：provider / modelId → 期望两者原样 roundtrip（含任意 `/`、`:`、unicode）。 */
const modelIdCases: readonly { provider: string; modelId: string; why: string }[] = [
  { provider: 'cmdc', modelId: 'deepseek/deepseek-v4.1-flash', why: 'TC3 的原始症状：modelId 含 1 个斜杠' },
  { provider: 'alpha', modelId: 'beta', why: '无斜杠的普通 id' },
  { provider: 'alpha', modelId: 'beta/gamma', why: 'modelId 含 1 个斜杠' },
  { provider: 'alpha', modelId: 'a/b/c/d', why: 'modelId 含多个斜杠（split 会碎成 4 段）' },
  { provider: 'vendor/with-slash', modelId: 'plain', why: 'provider 含斜杠（不依赖 provider 不含斜杠的假设）' },
  { provider: 'p/q', modelId: 'r/s', why: '两边都含斜杠' },
  { provider: 'p', modelId: 'openai:gpt-4o', why: 'modelId 含冒号' },
  { provider: '供应商', modelId: '模型/中文名', why: 'unicode + 斜杠' },
  { provider: 'p', modelId: 'x\\y"z', why: '反斜杠与引号（JSON 必须转义正确）' },
  { provider: 'p', modelId: '🙂/emoji', why: '星光面字符 + 斜杠' },
];

for (const { provider, modelId, why } of modelIdCases) {
  const optionValue = encodeModelSelection(provider, modelId);
  assert.ok(optionValue.length > 0, `option value 不该是空：${why}`);

  const { decoded, created, patched } = pickModelInForm(optionValue);
  assert.deepEqual(
    decoded,
    { providerId: provider, modelId: modelId },
    `decode 必须原样还回 provider/modelId（${why}）：${optionValue}`,
  );

  /* 关键：wire 上必须是**完整** modelId，不是被截断的前缀。 */
  assert.deepEqual(
    created.model,
    { mode: 'fixed', providerId: provider, modelId: modelId },
    `create body 必须带完整 modelId（${why}）`,
  );
  assert.deepEqual(
    patched.model,
    { mode: 'fixed', providerId: provider, modelId: modelId },
    `patch body 必须带完整 modelId（${why}）`,
  );

  /* 真实 JSON：断言序列化之后 modelId 仍然是完整串（顺带证明引号/反斜杠没被吃掉）。 */
  const wireJson = JSON.stringify({ expectedRevision: 1, patch: patched });
  assert.ok(
    wireJson.includes(JSON.stringify(modelId)),
    `wire JSON 必须含完整 modelId（${why}）：${wireJson}`,
  );
}

/* TC3 逐字对照：修复前的 split('/') 会把它截成 'deepseek'。 */
const tc3Option = encodeModelSelection('cmdc', 'deepseek/deepseek-v4.1-flash');
const tc3 = pickModelInForm(tc3Option);
assert.equal(tc3.decoded.modelId, 'deepseek/deepseek-v4.1-flash', 'TC3 modelId 必须完整');
assert.notEqual(tc3.decoded.modelId, 'deepseek', 'TC3 modelId 不得被截断为 deepseek');
assert.equal(
  JSON.stringify({ expectedRevision: 1, patch: tc3.patched }),
  '{"expectedRevision":1,"patch":{"model":{"mode":"fixed","providerId":"cmdc","modelId":"deepseek/deepseek-v4.1-flash"}}}',
  'TC3 的 wire JSON 必须逐字等于旧任务里 400 那个 body 的正确版本',
);

/* 空值 / 非法输入不得崩，且必须表示"未选"。 */
for (const bad of ['', '   ', 'not json', '["only-one"]', '["a","b","c"]', '{"a":"b"}', '["a",1]', '[1,2]', 'null', '42']) {
  assert.deepEqual(
    decodeModelSelection(bad),
    { providerId: '', modelId: '' },
    `非法/空值必须安全降级为未选而不是抛错：${JSON.stringify(bad)}`,
  );
}

/* 半选必须编码成空值，不能产出只带一半的 tuple。 */
assert.equal(encodeModelSelection('p', ''), '', 'modelId 为空时必须编码为空值');
assert.equal(encodeModelSelection('', 'm'), '', 'provider 为空时必须编码为空值');
assert.equal(encodeModelSelection('  ', '  '), '', '全空白必须编码为空值');
assert.equal(encodeModelSelection(' p ', ' m '), '["p","m"]', '编码时两端必须 trim');

/* select 自己的 value 也走同一 codec：继承态为空值。 */
assert.equal(modelSelectionValue(createAgentFormValues()), '', '继承态下拉值必须是空');
assert.equal(
  modelSelectionValue({ ...createAgentFormValues(), modelMode: 'fixed', providerId: 'a', modelId: 'b/c' }),
  encodeModelSelection('a', 'b/c'),
  'fixed 态下拉值必须与 option value 同 codec',
);

/* 已保存但目录里没有的模型：必须仍被标为"不可用"（以显示 fallback option），
   且 codec roundtrip 不得把 id 弄丢。 */
const unavailableDraft: AgentFormValues = {
  ...agentFormValuesFromDefinition(fixedStored),
  modelMode: 'fixed',
  providerId: 'cmdc',
  modelId: 'deepseek/deepseek-v4.1-flash',
};
const catalogueHas = (p: string, m: string): boolean => p === 'other' && m === 'x';
assert.equal(
  marksUnavailableModel(unavailableDraft, catalogueHas, true),
  true,
  '目录里没有的已存模型必须标为不可用',
);
assert.equal(
  marksUnavailableModel(unavailableDraft, () => true, true),
  false,
  '目录里有的模型不得标为不可用',
);
assert.equal(
  marksUnavailableModel(unavailableDraft, catalogueHas, false),
  false,
  '模型目录尚未读到不得判"不可用"（读失败不是证据）',
);
assert.equal(
  marksUnavailableModel(createAgentFormValues(), catalogueHas, true),
  false,
  '继承态不涉及固定模型，不得标为不可用',
);
/* fallback option 的 value 必须与 draft 的 value 完全相同，否则 select 会不匹配。 */
assert.equal(
  modelSelectionValue(unavailableDraft),
  encodeModelSelection('cmdc', 'deepseek/deepseek-v4.1-flash'),
  'fallback option 的 value 必须与当前 draft 的 select value 一致',
);
assert.equal(
  decodeModelSelection(modelSelectionValue(unavailableDraft)).modelId,
  'deepseek/deepseek-v4.1-flash',
  '不可用项的 id 必须 roundtrip 保持完整，不能被静默清空',
);

/* ---------------------------------------------------- 工具勾选与手输去重 */

assert.deepEqual(addToolName([], '  Bash  '), ['Bash'], '手输工具名必须 trim');
assert.deepEqual(addToolName(['Bash'], 'Bash'), ['Bash'], '重复添加不应产生第二条');
assert.deepEqual(addToolName(['Bash'], '   '), ['Bash'], '空输入不应加入');
assert.deepEqual(removeToolName(['Bash', 'Read'], 'Bash'), ['Read'], '移除只删命中项');
assert.deepEqual(
  selectedToolNames({ ...blank, toolsMode: 'selected', selectedTools: ['Bash'], extraTools: ['Bash', '  mcp__x__y '] }),
  ['Bash', 'mcp__x__y'],
  '勾选与手输合并后必须去重且 trim',
);
assert.deepEqual(selectAllToolNames(['Read', 'Grep'], ['Custom']), ['Read', 'Grep', 'Custom'], '全选应保留手输名');
assert.deepEqual(clearToolNames(), [], '全不选必须清空');

/* ------------------------------------------------------------ patch 变换 */

const stored: AgentDefinition = {
  id: 'a1',
  revision: 1,
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  name: '审查',
  description: '审查改动',
  systemPrompt: '只审查',
  model: { mode: 'inherit' },
  tools: { mode: 'all' },
  maxTurns: 8,
  maxConcurrentInstances: 1,
  enabled: false,
};

assert.deepEqual(
  isAgentFormDirty(agentFormValuesFromDefinition(stored), stored),
  false,
  '回填后的表单必须是干净的',
);
assert.deepEqual(
  patchFromValues(agentFormValuesFromDefinition(stored), stored),
  {},
  '未改动的表单必须产出空 patch（否则每次保存都成盲写）',
);

const edited = { ...agentFormValuesFromDefinition(stored), description: '新的描述', enabled: true };
const patch = patchFromValues(edited, stored);
assert.deepEqual(Object.keys(patch).sort(), ['description', 'enabled'], `patch 只应含改动项：${Object.keys(patch)}`);
assert.equal(patch.description, '新的描述');
assert.equal(patch.enabled, true);
assert.equal(patch.name, undefined, '未改动的名称不得出现在 patch 里');

const switched = {
  ...agentFormValuesFromDefinition(stored),
  toolsMode: 'selected' as const,
  selectedTools: ['Read'],
};
assert.deepEqual(patchFromValues(switched, stored).tools, { mode: 'selected', names: ['Read'] }, '工具模式切换必须进 patch');

/* thinkingLevel 是三态字段（task-29 的 AgentDefinitionPatch）：省略=保持原值，
   档位=换成该档，null=清空回继承。JSON 没有 undefined，所以"切回继承"必须显式
   发 null——否则存储里的档位会活过这次保存，等模型再切回 fixed 时又冒出来。 */

/* stored 基线没有档位；draft 也是继承（无档位）→ 一个字都不该发。 */
assert.equal(
  patchFromValues(agentFormValuesFromDefinition(stored), stored).thinkingLevel,
  undefined,
  '基线无档位、草稿也无档位时不得发送该字段',
);
assert.ok(
  !Object.hasOwn(patchFromValues(agentFormValuesFromDefinition(stored), stored), 'thinkingLevel'),
  '「不发」必须是键不存在，而不是键值 undefined（undefined 会被 JSON.stringify 丢掉，语义靠不住）',
);

/* stored 基线没有档位；draft 在继承态下带了个档位 → 继承态不生效，不该发。 */
const inheritWithLevel = { ...agentFormValuesFromDefinition(stored), thinkingLevel: 'high' as const };
assert.equal(
  patchFromValues(inheritWithLevel, stored).thinkingLevel,
  undefined,
  '继承模型时思考档位不能进 patch（它在那里不生效）',
);

/* 覆盖 thinkingLevel 四态的基线：fixed 模型 + 已存 high。 */
const withLevel: AgentDefinition = {
  ...stored,
  model: { mode: 'fixed', providerId: 'p', modelId: 'm' },
  thinkingLevel: 'high',
};

/* 态 1：stored 有档位 → draft 仍是同一档位（模型也没换）→ 不发该字段。 */
const unchangedLevel = {
  ...agentFormValuesFromDefinition(withLevel),
  modelMode: 'fixed' as const,
  providerId: 'p',
  modelId: 'm',
  thinkingLevel: 'high' as const,
};
assert.ok(
  !Object.hasOwn(patchFromValues(unchangedLevel, withLevel), 'thinkingLevel'),
  '档位未变时不得发送该字段',
);
assert.deepEqual(
  patchFromValues(unchangedLevel, withLevel),
  {},
  `什么都没改时应产出空 patch：${JSON.stringify(patchFromValues(unchangedLevel, withLevel))}`,
);

/* 态 2：stored 有档位 → draft 换档位 → 发新档位。 */
assert.equal(
  patchFromValues(
    {
      ...agentFormValuesFromDefinition(withLevel),
      modelMode: 'fixed' as const,
      providerId: 'p',
      modelId: 'm',
      thinkingLevel: 'max',
    },
    withLevel,
  ).thinkingLevel,
  'max',
  '换档位必须发新值',
);

/* 态 3：stored 有档位 → draft 清掉档位（仍 fixed）→ 必须发 null。 */
const clearedPatch = patchFromValues(
  { ...agentFormValuesFromDefinition(withLevel), modelMode: 'fixed' as const, providerId: 'p', modelId: 'm', thinkingLevel: undefined },
  withLevel,
);
assert.equal(clearedPatch.thinkingLevel, null, '清掉档位必须发 null，不能省略');
assert.ok(Object.hasOwn(clearedPatch, 'thinkingLevel'), 'null 必须是显式存在的键');
assert.equal(
  JSON.stringify(clearedPatch).includes('"thinkingLevel":null'),
  true,
  `清空必须真的进 JSON：${JSON.stringify(clearedPatch)}`,
);
assert.equal(
  JSON.stringify({ expectedRevision: 1, patch: clearedPatch }).includes('"thinkingLevel":null'),
  true,
  '真实请求体里必须带上 thinkingLevel:null',
);

/* 态 4：stored 无档位 → draft 选档位 → 发该档位。 */
assert.equal(
  patchFromValues(
    { ...agentFormValuesFromDefinition(stored), modelMode: 'fixed' as const, providerId: 'p', modelId: 'm', thinkingLevel: 'low' },
    stored,
  ).thinkingLevel,
  'low',
  '新增档位必须发该值',
);

/* 回归本 task 的原始症状：fixed+档位 → 切回继承必须同时发 model:inherit 和
   thinkingLevel:null；只发 model 会让档位活下来。 */
const backToInherit = patchFromValues(
  { ...agentFormValuesFromDefinition(withLevel), modelMode: 'inherit' as const },
  withLevel,
);
assert.deepEqual(backToInherit.model, { mode: 'inherit' }, '切回继承必须发 model:inherit');
assert.equal(backToInherit.thinkingLevel, null, '切回继承必须同时清掉存储的档位');
assert.deepEqual(
  Object.keys(backToInherit).sort(),
  ['model', 'thinkingLevel'],
  `切回继承只应动这两个字段：${Object.keys(backToInherit)}`,
);
assert.equal(
  JSON.stringify(backToInherit).includes('{"model":{"mode":"inherit"},"thinkingLevel":null}'),
  true,
  `切回继承的 JSON 必须同时带这两个值：${JSON.stringify(backToInherit)}`,
);

/* null 只能出现在 patch：draft 与 create body 都不含 null（对 API 无此值）。 */
assert.equal(
  agentFormValuesFromDefinition(withLevel).thinkingLevel,
  'high',
  '回填 draft 应拿到真实档位，绝不能是 null',
);
assert.equal(
  createInputFromValues({ ...agentFormValuesFromDefinition(withLevel), modelMode: 'inherit' as const }).thinkingLevel,
  undefined,
  'create body 在继承态下不得写档位',
);
assert.ok(
  !JSON.stringify(createInputFromValues(agentFormValuesFromDefinition(withLevel))).includes('null'),
  `create body 不得含任何 null：${JSON.stringify(createInputFromValues(agentFormValuesFromDefinition(withLevel)))}`,
);

/* ------------------------------------------------------- 409 保留草稿 */

const typedDraft = { ...blank, name: '我的草稿', description: '还没保存', systemPrompt: 'WRITE ME' };
const fresh = {
  revision: 99,
  agents: [{ ...stored, id: 'a2', name: '别人刚建的' }],
};
const reconciled = reconcileConflict(typedDraft, fresh);
assert.deepEqual(reconciled.draft, typedDraft, '409 之后草稿必须逐字段保留，不能被服务端数据覆盖');
assert.equal(reconciled.draft.systemPrompt, 'WRITE ME', '409 不得吞掉未保存的提示词');
assert.equal(reconciled.revision, 99, '409 必须采用服务端最新 revision，否则重试必然再次冲突');
assert.ok(
  reconciled.notice.includes('配置已被修改'),
  '409 必须提示冲突文案，不能静默重试',
);
assert.ok(
  reconciled.notice.includes('请检查后重新保存'),
  '409 文案必须要求用户检查后重新保存，暗示不得自动覆盖',
);

/* ================================= 1:1 复刻新增行为的钉子（task-51） =========
   颜色标记 / 注入 AGENTS.md / 工具自动全选 / 字段顺序与文案常量。
   文案常量逐字对照 ZCode `packages/ui/src/i18n/locales/zh-CN.ts:3314-3394`。
   ---------------------------------------------------------------------------- */

/* 八色顺序必须等于上游 `packages/ui/src/lib/subagentColors.ts:3-12`。 */
assert.deepEqual(
  [...AGENT_COLOR_ORDER],
  ['yellow', 'red', 'orange', 'green', 'cyan', 'blue', 'purple', 'pink'],
  '颜色顺序必须与 ZCode subagentColors.ts 一致（yellow→red→orange→green→cyan→blue→purple→pink）',
);
assert.deepEqual(
  [...SUBAGENT_COLORS],
  [...AGENT_COLOR_ORDER],
  'UI 展示顺序必须直接来自契约的 SUBAGENT_COLORS，不得自建一份',
);
/* 中文色名逐字取自 zh-CN:3389-3394。 */
assert.deepEqual(
  AGENT_COLOR_ORDER.map((color) => AGENT_COLOR_LABELS[color]),
  ['黄色', '红色', '橙色', '绿色', '青色', '蓝色', '紫色', '粉色'],
  '颜色中文名必须逐字等于 ZCode zh-CN 的「黄色/红色/橙色/绿色/青色/蓝色/紫色/粉色」',
);

/* 颜色三态：未指定 / 选定 / 再点同色即清除。 */
assert.equal(createAgentFormValues().color, undefined, '新建默认必须是「未指定颜色」');
assert.equal(toggleAgentColor(undefined, 'cyan'), 'cyan', '未指定时点色必须选中');
assert.equal(toggleAgentColor('cyan', 'blue'), 'blue', '换色必须直接替换');
assert.equal(toggleAgentColor('cyan', 'cyan'), undefined, '再点已选色必须清除（表达「未指定」）');

/* 颜色往返：读入 → 不改 → 空 patch；清除 → 发 null；设定 → 发值。 */
const colored: AgentDefinition = { ...fixedStored, color: 'purple' };
const coloredDraft = agentFormValuesFromDefinition(colored);
assert.equal(coloredDraft.color, 'purple', '已存颜色必须回填进草稿');
assert.equal(isAgentFormDirty(coloredDraft, colored), false, '仅回填未改动时必须是干净的草稿');
assert.equal(
  Object.hasOwn(patchFromValues(coloredDraft, colored), 'color'),
  false,
  '颜色未变时 patch 不得包含 color',
);
assert.equal(
  patchFromValues({ ...coloredDraft, color: undefined }, colored).color,
  null,
  '清除颜色必须发 null（省略=保持原值，JSON 没有 undefined）',
);
assert.equal(
  JSON.stringify({ expectedRevision: 1, patch: patchFromValues({ ...coloredDraft, color: undefined }, colored) })
    .includes('"color":null'),
  true,
  '清除颜色必须真的进 JSON',
);
assert.equal(
  patchFromValues({ ...coloredDraft, color: 'red' }, colored).color,
  'red',
  '换色必须发新值',
);
assert.equal(
  patchFromValues(agentFormValuesFromDefinition(fixedStored), fixedStored).color,
  undefined,
  '基线无颜色、草稿也无颜色时必须省略该字段',
);
assert.equal(
  Object.hasOwn(patchFromValues(agentFormValuesFromDefinition(fixedStored), fixedStored), 'color'),
  false,
  '「不发」必须是键不存在',
);
assert.equal(
  createInputFromValues(coloredDraft).color,
  'purple',
  'create body 必须带上草稿里的颜色',
);
assert.equal(
  Object.hasOwn(createInputFromValues(agentFormValuesFromDefinition(fixedStored)), 'color'),
  false,
  '未指定颜色的定义在 create body 里不得出现 color 键',
);

/* 注入 AGENTS.md：布尔直写，不需要 null（契约明确 false 是合法值）。 */
assert.equal(createAgentFormValues().injectAgentsMd, false, '新建默认必须是不注入 AGENTS.md');
assert.equal(
  agentFormValuesFromDefinition(fixedStored).injectAgentsMd,
  false,
  '定义里缺省 injectAgentsMd 时表单必须视为 false',
);
const injected: AgentDefinition = { ...fixedStored, injectAgentsMd: true };
const injectedDraft = agentFormValuesFromDefinition(injected);
assert.equal(injectedDraft.injectAgentsMd, true, '已存 injectAgentsMd 必须回填');
assert.equal(
  patchFromValues(injectedDraft, injected).injectAgentsMd,
  undefined,
  '未改动时 patch 不得包含 injectAgentsMd',
);
assert.equal(
  patchFromValues({ ...injectedDraft, injectAgentsMd: false }, injected).injectAgentsMd,
  false,
  '关掉注入必须如实发 false（false 是合法值，用不着 null）',
);
assert.equal(
  patchFromValues(agentFormValuesFromDefinition(fixedStored), fixedStored).injectAgentsMd,
  undefined,
  '基线 false、草稿 false 时不得发该字段',
);
assert.equal(
  createInputFromValues(injectedDraft).injectAgentsMd,
  true,
  'create body 必须带上 injectAgentsMd',
);

/* 工具：切到自定义且当前为空 → 自动全选当前可用项（ZCode :991-997）。 */
const catalogNames = ['Read', 'Grep', 'Glob', 'Bash'];
assert.deepEqual(
  initialSelectedToolsForCustom(catalogNames, []),
  catalogNames,
  '切到「自定义可用工具」且当前为空时必须自动全选当前可用项',
);
assert.deepEqual(
  initialSelectedToolsForCustom(catalogNames, ['Read']),
  ['Read'],
  '已有勾选时不得被自动全选覆盖（用户的选择优先）',
);
assert.deepEqual(
  initialSelectedToolsForCustom([], []),
  [],
  '目录为空时自动全选仍是空（不是错误）',
);
assert.notDeepEqual(
  initialSelectedToolsForCustom(catalogNames, []),
  [],
  '自动全选的结果必须非空——否则等于把「自定义」静默变成纯推理',
);
/* 空列表仍然合法（契约特性：纯推理），所以必须有显式清空路径。 */
assert.deepEqual(clearToolNames(), [], '必须保留显式清空入口');
assert.deepEqual(
  validateAgentForm({ ...named, toolsMode: 'selected', selectedTools: [], extraTools: [] }).errors,
  [],
  '清空后仍可保存（空 = 纯推理）',
);

/* 字段顺序：从组件源码断言，避免只靠肉眼。 */
const sectionSource = readFileSync(
  new URL('../src/components/settings/AgentDefinitionsSection.tsx', import.meta.url),
  'utf8',
);
const fieldLabels = ['nameLabel', 'colorLabel', 'modelLabel', 'descriptionLabel', 'toolsLabel', 'systemPromptLabel', 'injectAgentsMdLabel'];
const positions = fieldLabels.map((key) => {
  const index = sectionSource.indexOf(`COPY.${key}`);
  assert.ok(index > 0, `组件里必须渲染 COPY.${key}`);
  return index;
});
assert.deepEqual(
  [...positions].sort((a, b) => a - b),
  positions,
  '表单字段顺序必须是 名称→颜色标记→模型→(档位)→描述→可用工具→系统提示词→注入 AGENTS.md',
);
assert.ok(
  positions[1] < positions[2] && positions[2] < positions[3],
  '颜色必须在模型之前、描述之前（ZCode :1063 → :1095 → :1140）',
);
assert.ok(
  sectionSource.indexOf('showThinkingLevel') < positions[3],
  '思考档位必须紧跟模型、在描述之前',
);

/* 隐藏字段：最大轮数与并发上限不得再**渲染**。断言的是渲染面（COPY 常量与
   <Field> 标签），不是文件里出现过这个词——文档注释里说明「不再渲染」是对的。 */
for (const hidden of ['maxTurnsLabel', 'maxConcurrentLabel']) {
  assert.equal(
    sectionSource.includes(hidden),
    false,
    `隐藏字段「${hidden}」不得出现在组件里（用户已拍板隐藏）`,
  );
}
/* 也不能留下任何 number 输入框来改它们。 */
assert.equal(
  /type="number"/.test(sectionSource),
  false,
  '组件里不得再有 number 输入框（隐藏字段不应通过别的控件泄露出来）',
);

/* 文案常量逐字对照 ZCode zh-CN:3314-3394。 */
for (const [literal, where] of [
  ['子智能体', 'title'],
  ['搜索子智能体...', 'searchPlaceholder'],
  ['没有找到子智能体', 'empty'],
  ['新建子智能体', 'addNew'],
  ['填写子智能体名称、工具和系统提示词，保存后返回列表。', 'addDescription'],
  ['编辑子智能体', 'edit'],
  ['修改子智能体配置，保存后返回列表。', 'editDescription'],
  ['返回', 'backToList'],
  ['暂无描述', 'noDescription'],
  ['已安装', 'groupUser'],
  ['全部工具', 'toolsAll'],
  ['删除子智能体', 'deleteTitle'],
  ['颜色标记', 'colorLabel'],
  ['名称', 'nameLabel'],
  ['描述', 'descriptionLabel'],
  ['展示给模型的简短说明', 'descriptionPlaceholder'],
  ['可用工具', 'toolsLabel'],
  ['默认所有权限', 'toolsModeAll'],
  ['自定义可用工具', 'toolsModeCustom'],
  ['控制该子智能体可以调用的工具范围。', 'toolsCardTitle'],
  ['系统提示词', 'systemPromptLabel'],
  ['描述这个子智能体的角色、边界和规则...', 'systemPromptPlaceholder'],
  ['注入 AGENTS.md', 'injectAgentsMdLabel'],
] as const) {
  assert.ok(
    sectionSource.includes(literal),
    `组件文案「${literal}」缺失或与 ZCode zh-CN 不一致（${where}）`,
  );
}

/* ============ task-55：删除弹窗不得有额外交代 + 重试入口必须存在 ========== */

/* 1:1：ZCode 的删除弹窗只有标题+描述+确认（zh-CN:3350-3351）。我们曾多写一段
   「删除只影响配置…」，被独立验收判为偏离；这条断言防止它再被加回来。 */
assert.equal(
  sectionSource.includes('删除只影响配置'),
  false,
  '删除弹窗不得包含「删除只影响配置…」这段额外说明（1:1 偏离，已按 task-55 移除）',
);
assert.equal(
  sectionSource.includes('已经启动的子智能体不会被中断'),
  false,
  '删除弹窗不得包含额外安抚文案（ZCode 没有）',
);
/* ZCode 原文两段必须在，且描述作为**模板字面量**出现恰一次（注释里引用原文不算，
   doc 注释中出现第二次是说明用的，不渲染）。 */
assert.equal(
  (sectionSource.match(/`确定要删除子智能体「\$\{target\.name\}」吗？此操作无法撤销。`/g) ?? []).length,
  1,
  '删除弹窗描述必须恰好有一段模板字面量（不重复渲染）',
);
assert.ok(
  sectionSource.includes('确定要删除子智能体「${target.name}」吗？此操作无法撤销。'),
  '删除弹窗描述必须逐字等于 ZCode 原文',
);

/* 重试入口：模型目录与工具目录读取失败时都要能重试（ZCode :1748-1755，文案
   `common.retry` = 「重试」）。断言的是**渲染面**：每个错误分支里都必须有一个
   「重试」按钮，且文案逐字。 */
assert.ok(sectionSource.includes('重试'), '必须存在「重试」入口');
const retryLiteralCount = (sectionSource.match(/>重试</g) ?? []).length;
assert.ok(
  retryLiteralCount >= 3,
  `「重试」按钮至少要有 3 处（列表读取失败 / 模型目录失败 / 工具目录失败），实际 ${retryLiteralCount}`,
);
/* 每个失败分支都必须同时给出错误文本与重试：分别检查调用点。 */
for (const [label, loader] of [
  ['模型目录', 'loadModels'],
  ['工具目录', 'loadTools'],
  ['定义列表', 'loadDefinitions'],
] as const) {
  assert.ok(
    sectionSource.includes(`void ${loader}()`),
    `${label}失败时必须有重试调用（${loader}）`,
  );
}
/* 失败提示不得再是「只报错不给重试」的一句话。 */
assert.equal(
  sectionSource.includes('工具清单读取失败，工具徽标可能不完整。'),
  false,
  '工具目录失败不得只给一句提示而没有重试入口',
);
assert.equal(
  sectionSource.includes('模型徽标可能不完整'),
  false,
  '模型目录失败不得只给一句提示而没有重试入口',
);

/* ---------------- 窄屏布局：断点与防溢出规则必须真的在 CSS 里 --------------- */
const cssSource = readFileSync(
  new URL('../src/components/settings/AgentDefinitionsSection.module.css', import.meta.url),
  'utf8',
);
/* ≤640 时列头改为纵向堆叠，动作区不再靠右撑、搜索框占满整行。 */
assert.match(
  cssSource,
  /@media \(max-width: 640px\)/,
  '必须有 ≤640px 断点（390 窄屏退化修复的落点）',
);
const narrowBlock = cssSource.slice(cssSource.indexOf('@media (max-width: 640px)'));
const narrowBody = narrowBlock.slice(0, narrowBlock.indexOf('\n}\n') + 3);
assert.ok(
  /\.[a-zA-Z]+\s*\{[^}]*flex-direction: column/.test(narrowBody),
  '窄屏断点内必须把列头改为纵向堆叠（flex-direction: column）',
);
assert.ok(
  /margin-left: 0/.test(narrowBody),
  '窄屏断点内必须取消动作区的 margin-left: auto（否则标题被压成一条缝）',
);
/* 搜索框必须可收缩：固定 220px 会在窄面板里溢出。 */
assert.ok(
  /\.searchInput\s*\{[^}]*flex: 1 1 auto/.test(cssSource),
  '搜索输入必须 flex 收缩，不得钉死宽度',
);
assert.ok(
  /\.searchInput\s*\{[^}]*min-width: 0/.test(cssSource),
  '搜索输入必须有 min-width: 0（flex 项默认 min-width:auto 会顶破容器）',
);
/* 页面级防横向溢出：section 自身收口。 */
assert.ok(
  /\.section\s*\{[^}]*min-width: 0/.test(cssSource),
  'section 必须有 min-width: 0（否则被父 flex 压成内容内在宽度）',
);
assert.ok(
  /\.section\s*\{[^}]*overflow-x: clip/.test(cssSource),
  'section 必须 overflow-x: clip，保证内部不产生横向溢出',
);
/* 动作区按钮不得被裁切：窄屏下允许换行且宽度受限。 */
assert.ok(
  /white-space: nowrap/.test(narrowBody),
  '窄屏下行动按钮必须禁止逐字断行（否则会竖向堆字）',
);
assert.ok(
  /max-width: 100%/.test(narrowBody),
  '窄屏下行动按钮必须有 max-width: 100%，不得超出面板',
);

/* 已知偏离（按 Lead 判断，不实现、不伪造）：记录为断言，防止被误加。 */
assert.equal(
  sectionSource.includes('打开用户子智能体目录'),
  false,
  '不实现「打开用户子智能体目录」：Web 端无法打开系统文件夹（已知偏离）',
);
/* 「暂无描述」保持现状（task-51 按 1:1 引入了它），但它在我们的契约里不可达：
   description 是必填，所以这个兜底永远打不出来。记为已知偏离，不做改动。 */
assert.ok(
  sectionSource.includes('暂无描述'),
  '「暂无描述」保持现状（1:1 引入的兜底文案），本任务不改动',
);

/* ================= task-56：设置页外壳的窄屏挤压（根因不在 section） =====
   390 下内容列只有 128px、320 下 58px：这两数正好等于
   `视口 − 256(固定 rail) − 4(contentFrame) − 2(panel border) − 64(column gutter)`。
   所以修复落在设置页外壳，section 自身已经没问题了。
   ---------------------------------------------------------------------------- */

const shellCss = readFileSync(
  new URL('../src/components/settings/SettingsRoot.module.css', import.meta.url),
  'utf8',
);

/* 根因必须在：桌面端 rail 仍是固定 256px（1440 不回归的前提）。 */
assert.match(
  shellCss,
  /\.rail\s*\{[^}]*width: 256px/,
  '桌面端 rail 必须仍是固定 256px（1440 不回归）',
);
/* 断点：≤768 时 rail 让位。768 是「固定 rail + 各处内边距」还能容下列的临界点。 */
assert.match(
  shellCss,
  /@media \(max-width: 768px\)/,
  '必须有 ≤768px 外壳断点（390/320 挤压的修复落点）',
);
const shellNarrowStart = shellCss.indexOf('@media (max-width: 768px)');
const shellNarrow = shellCss.slice(shellNarrowStart);
assert.ok(shellNarrowStart > 0, '未找到外壳窄屏断点块');

/* 页面改列方向，rail 不再是「固定宽度的 flex 项」。 */
assert.ok(
  /\.page\s*\{[^}]*flex-direction: column/.test(shellNarrow),
  '窄屏下 .page 必须改为 column（否则 rail 仍与内容争宽）',
);
assert.ok(
  /\.rail\s*\{[^}]*width: 100%/.test(shellNarrow),
  '窄屏下 .rail 必须 width:100%（不再占固定侧栏宽）',
);
assert.ok(
  /\.rail\s*\{[^}]*overflow-x: auto/.test(shellNarrow),
  '窄屏下 .rail 必须 overflow-x:auto（横向可滚动 tab 条，且不撑宽页面）',
);
assert.ok(
  /\.rail\s*\{[^}]*flex-direction: row/.test(shellNarrow),
  '窄屏下 rail 内的导航必须改为横排',
);
/* 内容列 100% + min-width:0 —— 挤扁的直接解药。 */
assert.ok(
  /\.contentFrame\s*\{[^}]*width: 100%/.test(shellNarrow),
  '窄屏下 .contentFrame 必须 width:100%',
);
assert.ok(
  /\.contentFrame\s*\{[^}]*min-width: 0/.test(shellNarrow),
  '窄屏下 .contentFrame 必须 min-width:0',
);
/* 64px 内边距在手机上就是很大一块，让回去。 */
assert.ok(
  /\.column\s*\{[^}]*max-width: 100%/.test(shellNarrow),
  '窄屏下 .column 必须 max-width:100%',
);
assert.ok(
  /padding: 0 16px 24px/.test(shellNarrow),
  '窄屏下 .column 左右内边距必须收到 16px（32px 在手机上吃掉可读宽度）',
);
/* 导航文字不得逐字换行/截断。 */
assert.ok(
  /\.railNav \.navLabel\s*\{[^}]*white-space: nowrap/.test(shellNarrow),
  '窄屏 tab 文案必须 nowrap（否则竖排断字）',
);
/* 分组小标题在单行 tab 条里会读成游离文字，隐藏。 */
assert.ok(
  /\.navGroupLabel\s*\{[^}]*display: none/.test(shellNarrow),
  '窄屏必须隐藏分组小标题（横排里会读成游离文字）',
);

/* 桌面端规则不得被窄屏块污染：256px 与 896px 只在非窄屏出现。 */
assert.equal(
  /\.rail\s*\{[^}]*width: 256px/.test(shellNarrow),
  false,
  '窄屏块内不得再出现固定 256px rail 宽度',
);
assert.equal(
  /\.column\s*\{[^}]*max-width: 896px/.test(shellNarrow),
  false,
  '窄屏块内不得再出现 896px 列宽上限',
);

/* 三档预测宽度（浏览器复测交独立验证者；这里钉的是推导公式）。 */
const shellColumnWidth = (vw: number): number =>
  vw <= 768
    ? vw - 8 - 2 - 32      // rail 让位后：page → contentFrame(4*2) → panel(1*2) → column(16*2)
    : vw - 256 - 4 - 2 - 64; // 桌面：rail 256 + contentFrame 4 + panel 2 + column 32*2
assert.equal(shellColumnWidth(320), 278, '320 下内容列应为 278px（修复前 58px）');
assert.equal(shellColumnWidth(390), 348, '390 下内容列应为 348px（修复前 128px）');
assert.equal(shellColumnWidth(768), 726, '768 下内容列应为 726px（修复前 431px）');
assert.equal(shellColumnWidth(1440), 1114, '1440 桌面端不变（1114px）');
/* 按钮文案「新建子智能体」+ 图标 + 内边距约 124px，320 下也必须放得下。 */
assert.ok(shellColumnWidth(320) > 124, '320 下内容列必须宽于按钮最小内容宽，文字才不截断');

/* ================= task-64：内置分组与只读行 =================
   契约（task-62）在 GET 里把两个内置定义合并进 agents，并带 source/readOnly。
   UI 负责分组、只读渲染与计数口径。文案逐字取自 ZCode
   `packages/ui/src/i18n/locales/zh-CN.ts:3331-3332`。
   ---------------------------------------------------------------------------- */

/* 分组名与说明必须是 ZCode 原文。注意：ZCode 的组名是「内置子智能体」（不是
   「内置」），我按 zh-CN 原文取用并在交付说明里记了这处用词差异。 */
assert.ok(
  sectionSource.includes('内置子智能体'),
  '内置组名必须逐字为 ZCode 的「内置子智能体」(zh-CN:3331)',
);
assert.ok(
  sectionSource.includes('内置 profile 是运行时默认能力，当前不可在这里编辑。'),
  '内置组说明必须逐字为 ZCode 的 zh-CN:3332 原文',
);
assert.ok(sectionSource.includes('已安装'), '「已安装」组仍须在（zh-CN:3327）');

/* 顺序：内置组必须渲染在「已安装」组之前。 */
const builtinGroupAt = sectionSource.indexOf('COPY.groupBuiltIn');
const userGroupAt = sectionSource.indexOf('COPY.groupUser', sectionSource.indexOf('const matched'));
assert.ok(builtinGroupAt > 0 && userGroupAt > builtinGroupAt, '「内置子智能体」组必须排在「已安装」之前');

/* ---- 分组：纯函数分区，服务器给什么顺序就保持什么顺序 ---- */
const builtinStub = {
  ...fixedStored,
  id: 'builtin:general-purpose',
  name: 'general-purpose',
  source: 'builtin' as const,
  readOnly: true,
  enabled: true,
  color: 'blue' as const,
};
const builtinExplore = {
  ...fixedStored,
  id: 'builtin:explore',
  name: 'Explore',
  source: 'builtin' as const,
  readOnly: true,
  enabled: true,
  color: 'cyan' as const,
  tools: { mode: 'selected' as const, names: ['read', 'grep', 'find', 'ls'] },
};
const userDef = { ...fixedStored, source: 'user' as const, readOnly: false, enabled: false };

const groupedMixed = groupAgentDefinitions([builtinStub, builtinExplore, userDef]);
assert.deepEqual(
  groupedMixed.builtin.map((a) => a.name),
  ['general-purpose', 'Explore'],
  '内置组必须保持服务器给的顺序（general-purpose 在前，Explore 在后）',
);
assert.deepEqual(groupedMixed.user.map((a) => a.id), [userDef.id], '用户定义只能落在 user 组');
assert.equal(
  groupedMixed.builtin.length + groupedMixed.user.length,
  3,
  '分区必须是完整划分：两组合计等于输入总数（不丢行）',
);
/* 同名遮蔽：用户定义叫 general-purpose 时，它属于 user 组，内置那条仍在 builtin 组
   —— 服务端负责让同名的内置从列表中消失，UI 只做按 source 分区。 */
const shadow = { ...userDef, id: 'u-shadow', name: 'general-purpose' };
const groupedShadow = groupAgentDefinitions([builtinStub, shadow]);
assert.deepEqual(groupedShadow.user.map((a) => a.name), ['general-purpose'], '同名用户定义归 user 组');
assert.deepEqual(groupedShadow.builtin.map((a) => a.name), ['general-purpose'], 'UI 不自行做遮蔽判定（那是服务端的职责）');

/* ---- 计数口径：内置计入 total，且恒计入 enabled（没有开关） ---- */
assert.deepEqual(
  agentDefinitionCounts([builtinStub, builtinExplore, userDef]),
  { total: 3, enabled: 2 },
  '内置 2 个恒计 enabled；user 那条 enabled:false 不计入',
);
assert.deepEqual(
  agentDefinitionCounts([builtinStub, builtinExplore]),
  { total: 2, enabled: 2 },
  '只有内置时 total 与 enabled 都是 2（不再出现 0 个）',
);
assert.deepEqual(
  agentDefinitionCounts([]),
  { total: 0, enabled: 0 },
  '空列表仍是 0/0',
);
assert.deepEqual(
  agentDefinitionCounts([{ ...userDef, enabled: true }]),
  { total: 1, enabled: 1 },
  '用户定义启用时正常计入',
);
/* 计数必须与页脚模板一致。 */
assert.ok(
  sectionSource.includes('共 ${counts.total} 个子智能体 · ${counts.enabled} 个已启用'),
  '页脚必须用 agentDefinitionCounts 的口径',
);

/* ---- 只读行：不渲染开关、不渲染删除；点击不进入编辑 ---- */
assert.ok(
  sectionSource.includes('agent.readOnly'),
  '行组件必须按 readOnly 分支渲染',
);
assert.ok(
  /agent\.readOnly\s*\n?\s*\?\s*null/.test(sectionSource),
  'readOnly 行必须整块不渲染操作区（开关 + 删除）',
);
/* 内置行的回调：onToggle/onDelete 传 undefined，onOpen 只给提示。 */
const builtinRowCall = sectionSource.slice(
  sectionSource.indexOf('matched.builtin.map'),
  sectionSource.indexOf('matched.user.map'),
);
assert.ok(
  /onToggle=\{undefined\}/.test(builtinRowCall),
  '内置行不得接启用回调（无开关）',
);
assert.ok(
  /onDelete=\{undefined\}/.test(builtinRowCall),
  '内置行不得接删除回调（无删除图标）',
);
assert.ok(
  /setNotice\(\{ text: COPY\.groupBuiltInHint/.test(builtinRowCall),
  '点内置行必须只给一句轻提示，不进入编辑',
);
assert.equal(
  /openExisting/.test(builtinRowCall),
  false,
  '内置行绝不可调用 openExisting（不进入编辑）',
);
/* 用户行仍必须保留开关/删除/进入编辑。 */
const userRowCall = sectionSource.slice(sectionSource.indexOf('matched.user.map'));
assert.ok(/onToggle=\{/.test(userRowCall), '用户行必须仍有启用开关回调');
assert.ok(/onDelete=\{/.test(userRowCall), '用户行必须仍有删除回调');
assert.ok(/openExisting/.test(userRowCall), '用户行点击必须仍进入编辑');

/* ---- 搜索：某组无命中则整组隐藏；空态只在过滤后为空时出现 ---- */
assert.ok(
  sectionSource.includes('matched.builtin.length > 0 &&'),
  '内置组必须在无命中时整组隐藏',
);
assert.ok(
  sectionSource.includes('matched.user.length > 0 &&'),
  '「已安装」组必须在无命中时整组隐藏',
);
assert.ok(
  sectionSource.includes('const noMatches = matched.builtin.length === 0 && matched.user.length === 0'),
  '空态判据必须基于**过滤后**结果，而不是原始列表长度',
);
assert.equal(
  /agents\.length === 0 \?/.test(sectionSource),
  false,
  '不得再用 agents.length 判空态（内置永远存在，那会让默认态误显示空态）',
);
/* 内置存在时默认态不得出现「还没有子智能体定义」以外的空态文案。 */
assert.ok(
  sectionSource.includes('!hasSearch && noUserAgents &&'),
  '「还没有子智能体定义」只应在无搜索且用户组为空时出现',
);

/* ============ task-73：只读工具豁免的文案同步 ============
   task-70 让 `tools.mode='selected'` 下的只读工具（read/grep/find/ls）不再受父会话
   工具面限制。**先查旧句**：声称「子智能体不会拿到比当前对话更多的工具 / 不超过当前
   对话工具面」的那句在三个文件里都**不存在**（task-55 的 TOOL_BOUNDARY_NOTE 已在
   task-51 复刻时移除），所以没有"要改正的不准确旧句"；下面三条断言把这件事钉住，
   并确保新加的那句豁免说明不会被写成夸大版本。
   ------------------------------------------------------------------------- */

/* 1) 旧句不得回流——它现在已不准确。 */
for (const stale of [
  '子智能体工具范围不超过当前对话',
  '不会获得比当前对话更多',
  '不超过当前对话工具面',
  '工具范围不超过',
]) {
  assert.equal(
    sectionSource.includes(stale),
    false,
    `已失效的旧句不得回流：「${stale}」（task-70 后只读工具已豁免父级工具面）`,
  );
}

/* 2) 新句必须逐字存在（task-73 加入）。 */
assert.ok(
  sectionSource.includes(
    '只读工具（read/grep/find/ls）不受当前对话工具面限制；其它自定义工具仍以当前对话可用范围为上限。',
  ),
  '必须逐字渲染只读豁免说明（read/grep/find/ls 不受当前对话工具面限制）',
);
assert.ok(
  sectionSource.includes('{COPY.toolsCardHint}'),
  '豁免说明必须真的被渲染出来，而不是只定义常量',
);

/* 3) 不得夸大成"所有工具都不受限"——那会把写/命令类工具也一起放宽。 */
for (const overclaim of [
  '不受当前对话工具面限制的工具',
  '所有工具都不受',
  '全部工具均不受',
  '不受任何限制',
]) {
  assert.equal(
    sectionSource.includes(overclaim),
    false,
    `豁免文案不得夸大：${overclaim}`,
  );
}
/* 豁免说明必须点名只读工具集合，且必须保留"其它工具仍受上限"的限定。 */
assert.ok(
  /read\/grep\/find\/ls/.test(sectionSource),
  '豁免说明必须点名只读工具集合 read/grep/find/ls',
);
assert.ok(
  sectionSource.includes('其它自定义工具仍以当前对话可用范围为上限'),
  '豁免说明必须保留「其它自定义工具仍以当前对话可用范围为上限」的限定',
);
/* 空选择的后果那句仍必须保留（与新语义不矛盾）。 */
assert.ok(
  sectionSource.includes('未选择任何工具：该子智能体将只能推理，不能读写文件或执行命令。'),
  '空选择的警告仍须保留',
);

/* ---------------------------------------------- 组件最小渲染（真实 React） */

const markup = renderToStaticMarkup(
  h(ConfigProvider, { motion }, h(AgentDefinitionsSection, {})),
);
assert.ok(markup.length > 0, 'section 渲染出空串');
/* 1:1 复刻后默认进入列表态：标题 + 搜索 + 新建 + 分组 + 底部摘要。 */
assert.ok(markup.includes('新建子智能体'), '列表态缺少「新建子智能体」入口');
assert.ok(markup.includes('子智能体'), 'section 缺少子智能体文案');
assert.ok(markup.includes('搜索子智能体...'), '列表态缺少搜索框（文案须逐字等于 ZCode）');
assert.ok(markup.includes('共 0 个子智能体 · 0 个已启用'), '列表态缺底部摘要');
/* SSR 不跑 effect，所以这里看到的是**首帧**：列表态骨架 + 加载提示。
   真正的空态在数据返回后渲染（见下方 App 行为说明），首帧不该渲染表单字段。 */
assert.ok(markup.includes('加载中'), '首帧应显示加载提示');
/* 默认态不得出现表单字段。 */
assert.ok(!markup.includes('注入 AGENTS.md'), '列表态不该渲染表单字段');
/* 断言的是可见文案，不是标记串（类名里本来就会带 "Section"）。文案里那句
   「这里不做 Team / 任务编排」本身是边界声明，不算编排 UI，所以查的是编排控件
   才有的词。 */
const visibleText = markup.replace(/<[^>]*>/g, '');
for (const forbidden of ['任务板', '收件箱', '未读', '拉黑', '委派给', '编排面板']) {
  assert.ok(!visibleText.includes(forbidden), `本页不该出现编排 UI 文案「${forbidden}」：${visibleText.slice(0, 200)}`);
}

/* 传了 sessionId 也要能渲染（工具目录按会话作用域）。 */
const withSession = renderToStaticMarkup(
  h(ConfigProvider, { motion }, h(AgentDefinitionsSection, { sessionId: 's1' })),
);
assert.ok(withSession.includes('新建子智能体'), '带 sessionId 时渲染失败');

console.log('check-agent-definitions-ui: ok');
