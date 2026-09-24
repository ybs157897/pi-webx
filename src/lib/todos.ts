/**
 * 任务清单（todo 工具）的纯投影 —— 与 dsh 的 todo 工具同形：**整表替换 + 三态**
 * （`pending` / `in_progress` / `completed`），会话事件是唯一事实来源
 * （dsh 原话：*"Send the ENTIRE list every call — it REPLACES the previous list"*，
 * 见 `deepseek-harness/packages/todo/tool-todo/src/index.ts`）。
 *
 * 为什么要有这个模块：旧 pi 扩展（`pi-deck-todo`）的工具是「一次一项」的
 * `add` / `toggle`，模型写三个任务就得调三次工具，面板于是变成三行、还要分两批
 * （先三次 add、再三次 toggle）。dsh 的模型是一次调用交整张表：一行调用、一个快照，
 * UI 只读最后一张快照（last-write-wins）。
 *
 * 这里只做**纯函数**：不碰 React、不碰网络，UI 与 SSR 检查脚本共用同一套判定，
 * 免得「面板显示什么」在两个地方各写一遍。
 *
 * 兼容面（旧会话仍要诚实回放）：
 *   - 新形态 `details = { todos: [{ content, status }] }`（同时接受 args 直传）
 *   - 旧形态 `details = { action, todos: [{ id, text, done }] }`（pi-deck-todo）
 *   - widget 文本行（TUI 通道）—— 仅当会话里拿不到结构化的 todo 记录时的兜底
 */

import type { ToolRun, TranscriptEntry } from '../shared/transcript';

/** pi 里注册的任务工具名（扩展 `extensions/pi-webx-todo.ts` 注册的就是它）。 */
export const TODO_TOOL_NAME = 'todo';

/** 三态词表，顺序即 dsh 的 `STATUSES`。 */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** 一项任务：内容是模型写的原文（已 trim），状态是三态之一。 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/**
 * 由任务面板自己消费的 widget key。这些 key 的原始文本行不再当作代码块渲染：
 * 面板已经是它们的图形化形态，两处都画就是同一份状态出现两次。
 * `pi-deck-todo` 是旧扩展的 key，保留在表里是为了升级当口不出现双份。
 */
export const TODO_WIDGET_KEYS: readonly string[] = ['pi-webx-todo', 'pi-deck-todo'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 状态归一：三态直取；旧形态的 `done: boolean` 映射成 completed / pending。 */
function coerceStatus(value: unknown): TodoStatus | null {
  if (value === 'pending' || value === 'in_progress' || value === 'completed') return value;
  if (typeof value === 'boolean') return value ? 'completed' : 'pending';
  return null;
}

/** 单项归一：新形态读 `content`，旧形态读 `text`；内容为空或状态缺失即丢弃该项。 */
function coerceItem(value: unknown): TodoItem | null {
  if (!isRecord(value)) return null;
  const raw = typeof value.content === 'string' ? value.content : value.text;
  if (typeof raw !== 'string') return null;
  const content = raw.trim();
  if (content === '') return null;
  const status = coerceStatus(value.status ?? (value.done === undefined ? undefined : value.done));
  if (status === null) return null;
  return { content, status };
}

/**
 * 把一个 `{ todos: [...] }` 载荷归一成整表；形态不对（没有 todos、不是数组）返回 null，
 * 表示「这次调用没有可用的清单快照」，而不是「清单是空的」——空表是 `{ todos: [] }`。
 */
export function parseTodoList(value: unknown): TodoItem[] | null {
  if (!isRecord(value)) return null;
  const raw = value.todos;
  if (!Array.isArray(raw)) return null;
  const items: TodoItem[] = [];
  for (const entry of raw) {
    const item = coerceItem(entry);
    // 单项坏掉只丢这一项：整表是模型给的完整快照，不能因为一行不合格就把快照扔掉
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * 读一次工具调用的参数（可能是对象，也可能是模型流式写出的 JSON 字符串；
 * 流到一半解析失败就是「还没有快照」，返回 null）。
 */
export function todoItemsFromArgs(args: unknown): TodoItem[] | null {
  let value = args;
  for (let round = 0; round < 2 && typeof value === 'string'; round += 1) {
    const text = value.trim();
    if (text === '') return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return parseTodoList(value);
}

/** 一次 `todo` 调用贡献的快照：结果 details 优先（完整），其次调用参数（流式中）。 */
function runTodoItems(run: ToolRun): TodoItem[] | null {
  if (run.toolName !== TODO_TOOL_NAME) return null;
  if (run.status === 'error') return null;
  return parseTodoList(run.details) ?? todoItemsFromArgs(run.args);
}

/**
 * 会话当前的任务表：按顺序扫全部条目（含被折叠进 turn process 的步骤），
 * 最后一次成功的 `todo` 调用说了算 —— 与 dsh「replay 是 last-write-wins」一致。
 *
 * 空表等价于「没有任务」：模型用 `{ todos: [] }` 清空后，面板就该消失。
 */
export function latestTodos(entries: readonly TranscriptEntry[]): TodoItem[] {
  let latest: TodoItem[] = [];
  for (const entry of entries) {
    const runs =
      entry.kind === 'assistant' ? entry.tools : entry.kind === 'toolResult' ? [entry.run] : [];
    for (const run of runs) {
      const items = runTodoItems(run);
      if (items !== null) latest = items;
    }
  }
  return latest;
}

/** 三态计数。`active` 是进行中，`pending` 由总数减去前两者得到。 */
export interface PlanCounts {
  done: number;
  active: number;
  pending: number;
  total: number;
}

export function planCounts(todos: readonly TodoItem[]): PlanCounts {
  const done = todos.filter((item) => item.status === 'completed').length;
  const active = todos.filter((item) => item.status === 'in_progress').length;
  return { done, active, pending: todos.length - done - active, total: todos.length };
}

/**
 * 面板头部的一行摘要：`2 已完成　·　1 进行中　·　2 待处理`
 * （分隔符用 U+2002 EN SPACE，与 dsh `TodoPanel` 一致：HTML 会折叠连续半角空格）。
 * 计数为 0 的段落不显示 —— 非空表至少剩一段，空表返回空串。
 */
export function progressLabel(todos: readonly TodoItem[]): string {
  const { done, active, pending } = planCounts(todos);
  return [
    ...(done > 0 ? [`${done} 已完成`] : []),
    ...(active > 0 ? [`${active} 进行中`] : []),
    ...(pending > 0 ? [`${pending} 待处理`] : []),
  ].join('\u2002·\u2002');
}

/**
 * 工具卡一行的摘要两半（照 dsh `plan-summary.ts`）：`done / total` 与
 * 「第一个进行中的任务名 + 其余进行中数量」。两半不预先拼在一起 ——
 * 窄行会把任务名截断，`+K` 必须活在自己的不可收缩 span 里。
 */
export interface PlanSummary {
  done: number;
  total: number;
  /** 第一个 `in_progress` 的内容；没有进行中（或首项名字不可用）时为 null。 */
  activeContent: string | null;
  /** 除第一个之外的进行中数量；`activeContent` 为 null 时恒为 0。 */
  activeExtra: number;
}

export function planSummary(todos: readonly TodoItem[]): PlanSummary {
  const active = todos.filter((item) => item.status === 'in_progress');
  const first = active[0]?.content;
  const named = typeof first === 'string' && first.trim() !== '';
  return {
    done: todos.filter((item) => item.status === 'completed').length,
    total: todos.length,
    activeContent: named ? first : null,
    activeExtra: named ? active.length - 1 : 0,
  };
}

/**
 * widget 文本行的兜底解析（TUI 通道的形状，`extensions/pi-webx-todo.ts` 生产）：
 *
 * ```
 * 任务 1/3
 * ◐ 写第二个小故事
 * ☐ 写第三个小故事
 * ```
 *
 * 首行给出 `d/t`，其余每行以 `☑`（已完成）/ `◐`（进行中）/ `☐`（待处理）开头。
 * 只认这三种字形；认不出就返回 null，交给调用方决定（不猜）。
 */
const WIDGET_GLYPHS: Record<string, TodoStatus> = {
  '☑': 'completed',
  '◐': 'in_progress',
  '☐': 'pending',
};

export function todoItemsFromWidgetLines(lines: readonly string[]): TodoItem[] | null {
  const head = lines[0]?.match(/^\s*(?:任务|待办事项)\s+(\d+)\/(\d+)\s*$/);
  if (!head) return null;
  const items: TodoItem[] = [];
  for (const line of lines.slice(1)) {
    const match = line.match(/^\s*([☑◐☐])\s*(.+?)\s*$/);
    if (!match) continue;
    const status = WIDGET_GLYPHS[match[1] as string];
    const content = match[2] as string;
    if (status === undefined || content === '') continue;
    items.push({ content, status });
  }
  // 表头声明了数量，行数对不上说明这不是一张完整的快照 —— 不拿它当事实来源
  if (items.length !== Number(head[2])) return null;
  return items;
}
