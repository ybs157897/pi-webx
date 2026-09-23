/**
 * 权限菜单的形状钉子（图3）：菜单行只有「盾徽 + 名称 + 选中态 Check」一行，
 * **没有**第二行的命令清单。
 *
 * 原来每档在标签下面还把该档的工具集渲染一遍（`read / grep / find / ls` …）。那些
 * 工具名对用户不是信息：三档的差别已经写在档名里，第二行只是把同一件事又说一遍，
 * 还把每行撑成两行。dsh 的菜单（`ui-permission-presets/src/client/PermissionSelect.tsx`）
 * 只有「图标 + 名称」（外加 Auto review 的 EXP 角标），说明文案挂在 trigger 的
 * `title` 上，不在菜单行里。
 *
 * 数据层不动：`hint` 仍是 `src/shared/tool-presets.ts` 的字段（工具集本身是与
 * pi-web 对齐的底座，`scripts/check-tool-presets.ts` 逐档钉着），这里钉的是
 * **菜单不渲染它**。
 *
 * 为什么渲染 `ToolPresetMenu` 而不是 `ToolPresetSelect`：antd 的 Popover 在 SSR 下
 * 只渲染 trigger，弹层内容要打开才挂载。`ToolPresetMenu` 就是弹层里那一份 JSX 本身
 * （导出它只是让这段内容可被单独渲染，弹层行为没变），所以断言的是真菜单，不是复制品。
 *
 * 用法：`node --import ./scripts/check-bootstrap.mjs scripts/check-tool-preset-menu.ts`
 */
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolPresetMenu, ToolPresetSelect } from '../src/components/ToolPresetSelect';
import { TOOL_PRESET_OPTIONS, type ToolPreset } from '../src/shared/tool-presets';

const noop = (): void => {};

const renderMenu = (shown: ToolPreset, onApply?: (preset: ToolPreset) => void): string =>
  renderToStaticMarkup(h(ToolPresetMenu, { shown, onChoose: noop, onApply }));

const menu = renderMenu('default', noop);

// 三档中文标签都在，且按权限递进排列——删掉命令清单不许把档位本身也删了。
const labels = ['仅可查看', '工作区内修改', '完全权限'];
assert.deepEqual(
  TOOL_PRESET_OPTIONS.map((option) => option.label),
  labels,
  '三档标签变了：菜单的档位文案是这次改动的固定面',
);
for (const label of labels) {
  assert.ok(menu.includes(label), `菜单里没有「${label}」：${menu}`);
}
assert.ok(
  menu.indexOf('仅可查看') < menu.indexOf('工作区内修改')
  && menu.indexOf('工作区内修改') < menu.indexOf('完全权限'),
  '菜单顺序变了：必须仍是 仅可查看 → 工作区内修改 → 完全权限',
);

// 图3 的那三串命令清单一个都不许回来——这是本次改动的验收点。
const COMMAND_LISTS = [
  'read / grep / find / ls',
  'read / bash / edit / write',
  '工作区内修改 + grep / find / ls',
];
for (const list of COMMAND_LISTS) {
  assert.ok(!menu.includes(list), `菜单里还有命令清单「${list}」：${menu}`);
}
// 数据层的每一档 hint 都不许出现在菜单 HTML 里：上面三串是当下的事实，
// 这一轮跟着数据走，将来改了 hint 文案也不会漏掉。
for (const option of TOOL_PRESET_OPTIONS) {
  assert.ok(option.hint.trim() !== '', `${option.id} 的 hint 在数据层丢了`);
  assert.ok(
    !menu.includes(option.hint),
    `${option.id} 的 hint「${option.hint}」又渲染进菜单了：菜单行只能有一行`,
  );
}
// 第二行的样式指纹（原来那行是 `margin-top:1px` 的 11px 小字）也不许回来。
assert.ok(!menu.includes('margin-top:1px'), `菜单里又出现第二行的样式：${menu}`);

// 一行一档：三个按钮，每个按钮里两个 span（图标行 + 标签），没有多余的一行。
const rows = menu.split('<button').slice(1);
assert.equal(rows.length, 3, `菜单不是三行：${menu}`);
for (const [index, row] of rows.entries()) {
  assert.ok(row.includes('<svg'), `「${labels[index]}」这行丢了盾徽`);
  assert.equal(
    (row.match(/<span/g) ?? []).length,
    2,
    `「${labels[index]}」这行不是「盾徽 + 名称」一行：${row}`,
  );
}

// 选中态只有一个，且挂在传入的档位上（选中高亮逻辑没被这次删行改坏）。
assert.equal(
  (menu.match(/lucide-check/g) ?? []).length,
  1,
  `选中态 Check 不是恰好一个：${menu}`,
);
const checked = rows.filter((row) => row.includes('lucide-check'));
assert.equal(checked.length, 1, '选中态 Check 挂在多行上');
assert.ok(checked[0]!.includes('工作区内修改'), `选中态 Check 没挂在当前档上：${checked[0]!}`);
const readOnlyChecked = renderMenu('read-only', noop);
assert.ok(
  readOnlyChecked.split('<button')[1]!.includes('lucide-check'),
  '换一档后选中态没跟着走',
);

// 没有会话可选档时才有底部说明；有 onApply 就没有这句。
assert.ok(
  !menu.includes('发送第一条消息时按此预设创建会话'),
  '有会话可应用时不该再显示「创建会话」的说明',
);
assert.ok(
  renderMenu('default').includes('发送第一条消息时按此预设创建会话'),
  '没有会话时的底部说明丢了',
);

/**
 * trigger 那一侧：`aria-label` 与文案不变，档位的 hint 挪到了 `title`（tooltip）——
 * dsh 的 `PermissionSelect` 也是把预设说明放在 trigger 的 title 上，菜单行里不放。
 *
 * 注意这与上面「菜单不含命令清单」并不矛盾：这里渲染的是**收起状态的控件**，
 * 命令清单只作为 trigger 的原生 tooltip 存在，不在任何菜单行里。
 */
const trigger = renderToStaticMarkup(
  h(ToolPresetSelect, { current: 'read-only', onApply: noop }),
);
assert.match(
  trigger,
  /aria-label="工具集，当前：仅可查看"/,
  `trigger 的 aria-label 变了：${trigger}`,
);
assert.match(trigger, /title="read \/ grep \/ find \/ ls"/, `trigger 的 title 没带上当前档的 hint：${trigger}`);
assert.ok(trigger.includes('>仅可查看<') || trigger.includes('>仅可查看'), 'trigger 的文案变了');
assert.ok(!trigger.includes('工作区内修改'), 'trigger 上不该有别的档位文案');

console.log(
  'PASS 权限菜单：菜单行只有「盾徽 + 名称 + 选中态 Check」一行，'
  + '三串命令清单（read / grep / find / ls、read / bash / edit / write、工作区内修改 + grep / find / ls）都不在菜单 HTML 里，'
  + '三档中文标签与顺序不变、选中态跟着当前档走，档位 hint 仍在数据层、只作为 trigger 的 title 出现',
);
