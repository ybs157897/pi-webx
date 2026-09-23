/**
 * 工具预设三档权限菜单的钉子。
 *
 * composer 菜单从四项预设改为三档权限模式（仅可查看 → 工作区内修改 → 完全权限），
 * 「纯对话」退出菜单。这次重排不许碰的东西都在这里钉死：底层四值类型与三档
 * 工具集数组一字不动（旧会话记录、server 持久化、pi-web 对齐都压在它们上面），
 * 菜单只是展示层的重排。
 *
 * 菜单行后来又不显示工具清单了（每档标签下面那行 `read / grep / find / ls`）：
 * `hint` 仍是数据层的字段——它就是这一档启用了哪些工具，这里钉着它和工具集一致；
 * 「菜单 HTML 里没有命令清单」是渲染层的钉子，在 `check-tool-preset-menu.ts`。
 */
import assert from 'node:assert/strict';
import {
  isToolPreset,
  presetFromToolNames,
  toolNamesForPreset,
  toolPresetOption,
  TOOL_PRESET_OPTIONS,
  TOOL_PRESET_VALUES,
  type ToolPreset,
} from '../src/shared/tool-presets';

// 类型面不动：'none' 仍是合法值——旧会话记录里存着它，存储与协议没换代。
assert.deepEqual(
  [...TOOL_PRESET_VALUES],
  ['none', 'read-only', 'default', 'full'],
  'TOOL_PRESET_VALUES 变了：旧会话记录的 none 兼容面被破坏',
);

// 菜单恰三档，按权限递进排序，中文标签精确。
assert.deepEqual(
  TOOL_PRESET_OPTIONS.map((option) => option.id),
  ['read-only', 'default', 'full'],
  '菜单档位或顺序变了：权限菜单必须是 read-only → default → full 三档递进',
);
assert.deepEqual(
  TOOL_PRESET_OPTIONS.map((option) => option.label),
  ['仅可查看', '工作区内修改', '完全权限'],
  '菜单中文标签变了：三档文案与权限语义一一对应，不许随手改词',
);

// 每档有可区分的盾徽——菜单行靠图标一眼分层，撞图标=分层失效。
const iconKeys = TOOL_PRESET_OPTIONS.map((option) => option.iconKey);
assert.equal(new Set(iconKeys).size, 3, '三档 iconKey 有重复：每档的盾图标必须可区分');
assert.ok(
  iconKeys.every((key) => ['shield-check', 'shield-pen', 'shield-alert'].includes(key)),
  'iconKey 词表变了：三档盾徽（对勾/笔/感叹号）是菜单的视觉契约',
);

// 'none' 不在菜单里，但仍是合法值，且 legacy 文案诚实。
assert.ok(
  !TOOL_PRESET_OPTIONS.some((option) => option.id === 'none'),
  '「纯对话」回到菜单了：它已退出三档权限菜单',
);
assert.ok(isToolPreset('none'), 'isToolPreset("none") 失真：旧会话记录的 none 仍必须是合法预设');
const noneOption = toolPresetOption('none');
assert.equal(noneOption.label, '纯对话', 'none 的 legacy 文案丢了：恢复旧会话时 chip 必须诚实显示「纯对话」');
assert.ok(
  noneOption.hint.includes('不启用任何工具'),
  'none 的 hint 没说清「不启用任何工具」：空工具集的语义必须照实呈现',
);

// 三档的 hint 仍在数据层：它就是这一档启用了哪些工具。逐串钉住——菜单行删掉了这行
// 说明，数据层不许跟着一起消失（渲染层的钉子在 check-tool-preset-menu.ts）。
// `full` 的 hint 是相对 default 的增量描述（「工作区内修改 + 搜索三件套」），
// 所以它没有逐字再列一遍 bash/read/edit/write。
assert.deepEqual(
  TOOL_PRESET_OPTIONS.map((option) => option.hint),
  ['read / grep / find / ls', 'read / bash / edit / write', '工作区内修改 + grep / find / ls'],
  '三档 hint 变了：菜单不再显示它，但它仍是数据层对档位的描述',
);

// 三档工具集逐项不变——这是与 pi-web 对齐的底座，改一个工具名就是语义变更。
assert.deepEqual(toolNamesForPreset('read-only'), ['read', 'grep', 'find', 'ls'], 'read-only 工具集变了');
assert.deepEqual(toolNamesForPreset('default'), ['read', 'bash', 'edit', 'write'], 'default 工具集变了');
assert.deepEqual(
  toolNamesForPreset('full'),
  ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'],
  'full 工具集变了',
);
assert.deepEqual(toolNamesForPreset('none'), [], 'none 工具集变了：纯对话必须一个工具都不启用');

// 档位 ↔ 工具集往返一致：从工具集认档、再展开回工具集必须闭环。
for (const preset of [...TOOL_PRESET_VALUES]) {
  assert.equal(
    presetFromToolNames(toolNamesForPreset(preset)),
    preset,
    `${preset} 的工具集往返不一致：恢复会话时会认错档位`,
  );
}

// presetFromToolNames 的判定边界。
assert.equal(presetFromToolNames([]), 'none', '空工具列表必须判为 none：无工具就是纯对话');
assert.equal(
  presetFromToolNames(['powershell', 'read', 'edit', 'write']),
  'default',
  'Windows 拼法 powershell 没归一到 bash：恢复 Windows 会话会认不出档位',
);
assert.equal(
  presetFromToolNames(['read', 'bash', 'edit', 'write', 'acme-ext']),
  'default',
  '扩展工具不该挡住档位识别：内置集之外的追加不算变更档位',
);
assert.equal(
  presetFromToolNames(['read', 'bash']),
  'default',
  '不完整/未知的工具杂集必须兜底 default 档，不许猜成别的档',
);

// 垃圾值兜底：越过一个非法值进去（坏存储、旧载荷），必须落到 default 档。
const garbage = 'does-not-exist' as ToolPreset;
assert.equal(
  toolPresetOption(garbage).id,
  'default',
  '垃圾预设值的兜底档变了：非法值必须落到 default 档，而不是按下标摸到哪档算哪档',
);

console.log('PASS 工具预设：三档权限菜单（仅可查看/工作区内修改/完全权限），none 兼容与工具集底座不动，三档 hint 留在数据层（菜单不再渲染），垃圾值兜底 default');
