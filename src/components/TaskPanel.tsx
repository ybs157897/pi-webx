/**
 * 会话的任务面板 —— dsh `TodoPanel` 的移植
 * （`deepseek-harness/packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx`）。
 *
 * 形状逐条对齐参考实现：
 *   - 一行头部：清单字形 ·「任务」· 三态计数摘要 · chevron，整行是一个 button
 *     （`aria-expanded` 报折叠态）；
 *   - 每项一行，行上挂 `data-status`，左首是 14×14 的三态字形画在 16×16 的格子里：
 *     completed = 圆环 + 对勾（成功色）、in_progress = 渐变圆环 + CSS 旋转（business 色）、
 *     pending = 虚线圆环（caption 色）。svg 的 path / 渐变 stop / `2.4 2.4` 虚线
 *     全部逐字搬自参考实现，不重画；
 *   - 列表 180px 自滚、行距 8px、13px 行高（样式在 `TaskPanel.module.css`）。
 *
 * 数据与判定都不在这里：`todos` 由调用方从 `src/lib/todos.ts`（冻结的纯投影）
 * 拿到 —— 计数摘要用它的 `progressLabel`，段序 / U+2002 分隔 / 零计数省略都钉在那里，
 * 组件不重写这些规则。**两个数据来源的次序**由本模块导出的 `todosForPanel` 决定
 * （见该函数），App 只负责在 `useMemo` 里调用它。
 *
 * **一处有意的偏离**：dsh 默认折叠（`useState(true)`），本面板默认**展开**。
 * dsh 的宿主是 dock 里的一行，摘要就够；这里用户要的是图1 那种一眼看到条目的面板，
 * 所以初始态是展开，点击头部折叠。折叠后的头部仍带完整摘要，收起不等于失联。
 */
import { useId, useState } from 'react';

import type { TodoItem, TodoStatus } from '../lib/todos';
import {
  latestTodos,
  progressLabel,
  todoItemsFromWidgetLines,
  TODO_WIDGET_KEYS,
} from '../lib/todos';
import type { WidgetState } from '../lib/usePiSession';
import type { TranscriptEntry } from '../shared/transcript';
import {
  IconChecklistOutline14,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
} from '../ui/primitives/index.ts';
import css from './TaskPanel.module.css';

/** 面板标题。参考实现走 locale，这里只有中文一种。 */
const TITLE = '任务';

export interface TaskPanelProps {
  /** 会话当前的任务表；空表不渲染任何东西（清空任务 = 面板消失）。 */
  todos: readonly TodoItem[];
}

/**
 * 面板的数据来源，两个来源的**次序本身就是判定**：
 *
 *   1. 结构化的 `todo` 调用记录 —— `src/lib/todos.ts` 的 last-write-wins 投影，
 *      会话事件是唯一事实来源；
 *   2. widget 文本行 —— 旧会话（`pi-deck-todo`）只有 TUI 通道，拿不到结构化记录时
 *      解析出任务表，面板不至于空白。
 *
 * widget 只在没有结构化快照（空表）时才看，解析不出来（行数与表头不符等）就当没有
 * 清单 —— 不猜。兜底不看 widget 的 placement：这是同一份状态的文本通道，放哪一侧
 * 都是同一张表（`WidgetStrip` 已经不再画这些 key 的原文，见 `StatusStrip.tsx`）。
 *
 * 判定放在这里而不是 App 里：它必须能被 `scripts/check-task-panel.ts` 用原始输出
 * 证明，而 App 的模块图在模块级就摸 `window`（`src/lib/connection.ts` 的
 * `sharedConnection`），在 Node 里 import 不起来。App 侧只剩一次记忆化调用。
 */
export function todosForPanel(
  entries: readonly TranscriptEntry[],
  widgets: Record<string, WidgetState>,
): TodoItem[] {
  const structured = latestTodos(entries);
  if (structured.length > 0) return structured;
  for (const key of TODO_WIDGET_KEYS) {
    const widget = widgets[key];
    if (widget === undefined || widget.lines.length === 0) continue;
    const parsed = todoItemsFromWidgetLines(widget.lines);
    if (parsed !== null && parsed.length > 0) return parsed;
  }
  return structured;
}

/** 闭合联合的兜底：三态之外的状态是类型外的东西，宁可炸掉也不要画错字形。 */
function assertNever(value: never): never {
  throw new Error(`unreachable todo status: ${String(value)}`);
}

/** 已完成：圆环 + 对勾（path 逐字来自参考实现）。 */
function CompletedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphCompleted}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 进行中：business 色圆环，尾端渐隐；旋转交给 CSS。 */
function ProgressGlyph() {
  const gradientId = useId();
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphProgress}>
      <defs>
        <linearGradient id={gradientId} x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
    </svg>
  );
}

/** 待处理：虚线圆环（figma dash 2.4 2.4）。 */
function PendingGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphPending}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  );
}

function StatusGlyph({ status }: { status: TodoStatus }) {
  switch (status) {
    case 'completed':
      return <CompletedGlyph />;
    case 'in_progress':
      return <ProgressGlyph />;
    case 'pending':
      return <PendingGlyph />;
    default:
      return assertNever(status);
  }
}

export function TaskPanel({ todos }: TaskPanelProps) {
  // 参考实现是 `useState(true)`（默认折叠）；这里默认展开，见文件头「有意的偏离」。
  const [collapsed, setCollapsed] = useState(false);
  if (todos.length === 0) return null;

  return (
    <section className={css.root} data-testid="todo-panel" aria-label={TITLE}>
      <div className={css.body}>
        <button
          type="button"
          className={css.header}
          aria-expanded={!collapsed}
          onClick={() => { setCollapsed((v) => !v); }}
        >
          <span className={css.lead} aria-hidden="true"><IconChecklistOutline14 /></span>
          <span className={css.title}>{TITLE}</span>
          <span className={css.progress}>{progressLabel(todos)}</span>
          <span className={css.chevron} aria-hidden="true">
            {collapsed ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
          </span>
        </button>
        {!collapsed && (
          <ul className={css.list}>
            {todos.map((item, index) => (
              // 参考实现只拿 content 当 key；dsh 的 todo 允许两行同样措辞，
              // 那样 key 会撞，所以带上位置（列表是整表替换，位置在快照内是稳的）。
              <li key={`${String(index)}:${item.content}`} className={css.item} data-status={item.status}>
                <span className={css.glyph} aria-hidden="true"><StatusGlyph status={item.status} /></span>
                <span className={css.content}>{item.content}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
