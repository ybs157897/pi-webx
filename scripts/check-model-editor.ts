/**
 * 模型编辑器：输入类型那行画哪些 chip，一次保存会动到 `piWebx` 的哪些键，
 * 以及推理等级行的勾选契约。
 *
 * 三件事在这里被钉住，因为它们在浏览器里都不好看出来：
 *
 * 1. **参考实现的行是 文本 / 图片 / 视频 / PDF**，没有音频。音频这个键仍然是
 *    合法的*存储*键（`ModelExtension['inputFormat']` 收），所以它不能因为"表单
 *    没画这个 chip"就被一次无关的编辑顺手删掉——那是在删用户自己写进
 *    models.json 的值，而且他看不见。
 * 2. 因此保存的规则是一句话：**表单画出来的键按表单写，没画的键原样继承**。
 *    这条规则在 `buildModelExtension` 里只写一次，所以它可以在没有 DOM 的情况下
 *    被断言——不然它只能靠点浏览器来验，而点浏览器进不了 `npm run check`。
 * 3. 推理等级是一排勾选框（用户要求，有意偏离参考的光名 chip + ＋ 下拉）。
 *    勾选集的词表序与幂等收在纯函数 `toggleThinkingLevel` 里；顺序一旦漂掉，
 *    写进 models.json 的 `thinkingLevelMap` 键序就跟着输入顺序走而不是 pi 的
 *    低→高，且只在重开弹窗时才看得见。
 */
import assert from 'node:assert/strict';

import {
  CAPABILITY_LABELS,
  EXTENSION_CHIPS,
  buildModelExtension,
} from '../src/components/settings/model-extension';
import type { ExtensionSelection } from '../src/components/settings/model-extension';
import { toggleThinkingLevel } from '../src/components/settings/thinking-levels';
import { copy, t } from '../src/components/settings/copy';
import { PI_THINKING_LEVELS } from '../src/shared/protocol';
import type { PiThinkingLevel } from '../src/shared/protocol';
import { IconLockOutline16 } from '../src/ui/primitives/icons';
import type { ModelExtension } from '../src/shared/models-config';

/** A selection with every chip off and an empty map — the "cleared everything" form. */
function emptySelection(over: Partial<ExtensionSelection> = {}): ExtensionSelection {
  return {
    inputs: { video: false, pdf: false },
    capabilities: { jsonSchemaOutput: false, nativeWebSearch: false, midConversationSystem: false },
    reasoningLevelMap: '',
    ...over,
  };
}

// The reference's input row, as the row the editor renders. Adding a chip here
// fails on purpose: the reference (and what pi can actually consume) decides it.
assert.deepEqual(
  [...EXTENSION_CHIPS],
  ['video', 'pdf'],
  '输入类型的 chip 只有 视频 / PDF（文本与图片走 pi 的 input，音频没有 chip）',
);

// Every capability flag the form does NOT draw a chip for must survive too — the
// same rule as the input kinds, and the reason the two branches now read alike.
const stored: ModelExtension = {
  enabled: true,
  inputFormat: { audio: true, video: true },
  capabilities: { nativeWebSearch: true, toolCall: true },
  reasoningLevelMap: 'reasoningLevel == "off" ? { enabled: false } : {}',
  futureKey: 'kept',
} as ModelExtension;

const cleared = buildModelExtension(stored, emptySelection());
assert.ok(cleared, '还有没画的键要留，清空整张表单不该把扩展整个删掉');
assert.deepEqual(
  cleared.inputFormat,
  { audio: true },
  '音频没有 chip，所以保存必须原样继承它；视频有 chip，取消勾选就该消失',
);
assert.deepEqual(
  cleared.capabilities,
  { toolCall: true },
  '没有 chip 的能力位要继承，有 chip 的按表单走',
);
assert.equal(cleared.reasoningLevelMap, undefined, '映射框清空即删掉该键');
assert.equal(cleared.enabled, true, '智能配置这类不在这张表单里的键也要留住');
assert.equal((cleared as Record<string, unknown>)['futureKey'], 'kept', '不认识的键原样保留');

// What the form says, the form decides: a chip that IS drawn writes its own value.
const kept = buildModelExtension(stored, {
  inputs: { video: true, pdf: true },
  capabilities: { jsonSchemaOutput: true, nativeWebSearch: false, midConversationSystem: true },
  reasoningLevelMap: '{}',
});
assert.ok(kept);
assert.deepEqual(kept.inputFormat, { audio: true, video: true, pdf: true }, '勾上的 chip 写进配置');
assert.deepEqual(
  kept.capabilities,
  { jsonSchemaOutput: true, midConversationSystem: true, toolCall: true },
  '勾上的能力位写进配置，没勾的（且画了的）删掉，没画的留着',
);
assert.equal(kept.reasoningLevelMap, '{}');
assert.equal(
  Object.keys(CAPABILITY_LABELS).length,
  3,
  '参考实现的能力 chip 是结构化输出 / 原生联网搜索 / 对话中系统消息',
);

// An entry that records nothing has no `piWebx` at all — the extension is
// optional, so clearing the last drawn key must not leave `{}` behind.
assert.equal(buildModelExtension(undefined, emptySelection()), undefined, '本来就没有扩展、表单也没填，不凭空造一个');
assert.equal(
  buildModelExtension({ inputFormat: { video: true } }, emptySelection()),
  undefined,
  '最后一个画出来的键被取消勾选后，扩展应该整个消失而不是留个空对象',
);

// The row's tooltip is part of the same claim: it lists the kinds that are
// recorded-only, so it must not name a kind the row no longer offers. (It did —
// the chip went away and the sentence kept saying 音频.)
assert.ok(
  t('extensionInputHint').includes('视频') && t('extensionInputHint').includes('PDF'),
  `输入类型的提示要列出被记录的两种输入：${t('extensionInputHint')}`,
);
assert.ok(
  !t('extensionInputHint').includes('音频'),
  `输入类型的提示不该再提音频（那一行没有音频 chip）：${t('extensionInputHint')}`,
);

// 文本 chip 的锁：这个字形是照参考手绘的（vendored 图标集里原本没有 lock），
// 所以它得真的被导出、真的能渲染，而不是只写在注释里。
assert.equal(typeof IconLockOutline16, 'function', '锁定态要有一个能用的锁字形');
const lockSvg = IconLockOutline16({ size: 13 });
assert.ok(lockSvg && lockSvg.props && lockSvg.props.viewBox === '0 0 16 16', '锁字形要是 16 格画布');

// 推理等级行是一排词表序勾选框：勾一个等级后数组必须严格回到 pi 的低→高序，
// 而不是把新等级追加到尾部——顺序漂了，thinkingLevelMap 的键序就跟着漂。
assert.equal(PI_THINKING_LEVELS.length, 7, '等级行一排 7 档：off 到 max，词表变了这里先红');
assert.deepEqual(
  toggleThinkingLevel(['max', 'off'], 'medium'),
  ['off', 'medium', 'max'],
  '勾选 medium 后必须按词表序排成 off → medium → max，不能追加到尾部',
);

// 勾选是集合语义：反复点击收敛到一份，不累积；取消勾选要删干净。
assert.deepEqual(
  toggleThinkingLevel(toggleThinkingLevel(toggleThinkingLevel([], 'low'), 'low'), 'low'),
  ['low'],
  '勾 → 取消 → 再勾后 low 恰好一份：重复点击必须收敛，不得长出重复项',
);
assert.deepEqual(
  toggleThinkingLevel(['off', 'low', 'max'], 'low'),
  ['off', 'max'],
  '取消勾选 low 后要删干净，其余等级原样保留',
);
assert.deepEqual(
  PI_THINKING_LEVELS.reduce((acc, level) => toggleThinkingLevel(acc, level), [] as PiThinkingLevel[]),
  [...PI_THINKING_LEVELS],
  '从空开始把 7 档全勾一遍，结果必须恰为整张词表各一份、低→高',
);

// 下拉追加的交互不许回流：copy 里那对「添加 / 移除推理等级」文案是随
// chipButton + ＋ 下拉一起删的，它们回来就说明那套交互也跟着回来了。
const copyKeys = Object.keys(copy) as (keyof typeof copy)[];
assert.ok(
  !copyKeys.includes('addLevel') && !copyKeys.includes('removeLevel'),
  'copy.ts 不该再有 addLevel/removeLevel：等级行已改成勾选框，下拉式交互不得回流',
);

console.log('PASS 模型编辑器：输入类型只有 视频/PDF（无音频），保存只动表单画出来的键、其余原样继承；推理等级行是一排词表序勾选框，下拉交互已删');
