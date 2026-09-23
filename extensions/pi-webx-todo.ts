/**
 * pi extension: 把 pi 的任务工具改成 dsh `todo_write` 同形的**整表替换**。
 *
 * 为什么这么改（根因）：旧扩展 `pi-deck-todo.ts` 的工具参数是
 * `{action:'list'|'add'|'toggle'|'clear', text?, id?}` —— 一次只能加一项/勾一项。
 * 模型写「3 个任务」就得调 3 次 add，做完再调 3 次 toggle，面板于是出现 6 行
 * （先三行 add、再三行 toggle）。dsh 的模型是一次调用交整张表：一行调用、一个快照，
 * UI 读最后一张快照（last-write-wins，见
 * `deepseek-harness/packages/todo/tool-todo/src/index.ts`）。
 *
 * 本扩展注册的 `todo` 工具：
 *   - 参数 `{ todos: [{ content, status }] }`，必填，**整表替换**（无部分更新、无逐项编辑）；
 *   - 状态三态 `pending` / `in_progress` / `completed`，同时进行中最多 1 项；
 *   - 结果 `details` 的形状就是 `{ todos }`（pi-webx 面板的唯一读取面，见 `src/lib/todos.ts`）；
 *   - 校验失败时**改走 content 文本**（不抛异常），且 details 回填「未被采纳的当前表」，
 *     这样面板不会被一次非法调用改写；
 *   - widget key `pi-webx-todo`，行格式与 `src/lib/todos.ts` 的 `todoItemsFromWidgetLines`
 *     对齐（首行 `任务 d/t`，其后 `☑|◐|☐ 内容`）。
 *
 * 部署：`cp extensions/pi-webx-todo.ts ~/.pi/agent/extensions/pi-webx-todo.ts`
 * （旧的 `~/.pi/agent/extensions/pi-deck-todo.ts` 必须移开，两个扩展会抢同一个工具名）。
 */

// @ts-nocheck — 由 pi 自己的运行时（jiti 别名）加载，这些模块由它提供。
import { Type } from 'typebox';

/** widget key：`src/lib/todos.ts` 的 TODO_WIDGET_KEYS 里认这个 key。 */
const WIDGET_KEY = 'pi-webx-todo';
/** 工具名：`src/lib/todos.ts` 的 TODO_TOOL_NAME。 */
const TOOL_NAME = 'todo';
/** dsh 的三态词表，顺序即 dsh 的 STATUSES。 */
const STATUSES = ['pending', 'in_progress', 'completed'];
const STATUS_SET = new Set(STATUSES);
/** widget 字形（与 `src/lib/todos.ts` 的 WIDGET_GLYPHS 逐字相同）。 */
const GLYPH = { completed: '☑', in_progress: '◐', pending: '☐' };

/**
 * 模型可见的工具描述，措辞照 dsh 的 `describe(false)`
 * （HEAD + SINGLE + TAIL，只改三处拼接，不改字）。
 */
const DESCRIPTION =
  'Record and update a structured task list for the current work. Send the ENTIRE '
  + 'list every call — it REPLACES the previous list (there are no partial updates, '
  + 'no per-item edits). Use it to plan multi-step work and show progress: add one '
  + 'todo per concrete step before you start. '
  + 'Keep AT MOST ONE todo `in_progress` at a '
  + 'time; while work remains, exactly one active task should be `in_progress`. '
  + 'Mark a todo '
  + '`completed` the moment it is done (do not batch completions), and allow no '
  + '`in_progress` item only once all work is complete. Skip the list for trivial '
  + 'single-step tasks. Statuses: `pending` (not started), `in_progress` (being '
  + 'worked on now), `completed` (finished).';

/** 状态 schema：用 `Type.Unsafe` 生成 `{type:'string',enum:[...]}`（Google 等不支持 anyOf 的 provider 也认）。 */
const StatusSchema = Type.Unsafe({
  type: 'string',
  enum: STATUSES,
  description: 'pending (not started) | in_progress (now) | completed (done).',
});

const TodoParams = Type.Object({
  todos: Type.Array(
    Type.Object(
      {
        content: Type.String({ description: 'What the task is — a short imperative line.' }),
        status: StatusSchema,
      },
      { additionalProperties: false },
    ),
    { description: 'The COMPLETE task list, replacing any previous list.' },
  ),
});

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const trim = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * **写入路径**的校验（严格）：模型给的整张表 → 规范表。
 * 照 dsh 的 `toTodoList`：content trim 后非空、同表内不得重复、同时进行中最多 1 项。
 * 不抛异常 —— 返回 `{ok:false,error}`，由 execute 转成 content 文本让模型自己改。
 */
function toTodoList(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, error: '`todos` 必须是数组：每次调用都要提交整张任务表' };
  }
  const todos = [];
  const seen = new Set();
  let active = 0;
  for (const item of raw) {
    if (!isRecord(item)) {
      return { ok: false, error: '每一项必须是 { content, status } 对象' };
    }
    const content = trim(item.content);
    if (content === '') {
      return { ok: false, error: '`content` 不能为空（trim 后必须非空）' };
    }
    if (seen.has(content)) {
      return { ok: false, error: `同表内内容重复：${JSON.stringify(content)}` };
    }
    seen.add(content);
    if (!STATUS_SET.has(item.status)) {
      return {
        ok: false,
        error: `\`status\` 必须是 ${STATUSES.join(' / ')}，收到 ${JSON.stringify(item.status)}`,
      };
    }
    if (item.status === 'in_progress') active += 1;
    todos.push({ content, status: item.status });
  }
  if (active > 1) {
    return {
      ok: false,
      error: `同时进行中的任务最多 1 项（收到 ${active}）：顺序工作时只把当前那项标 in_progress`,
    };
  }
  return { ok: true, todos };
}

/**
 * **读取路径**的归一（宽松）：会话里已有的快照 → 规范表。
 * 新形态读 `content`/三态 `status`；旧形态（pi-deck-todo）读 `text`/`done:boolean`，
 * 这样升级当口恢复旧会话时 widget 不会空白（`src/lib/todos.ts` 的兼容面同理）。
 * 单项坏掉只丢这一项 —— 整表是模型给的完整快照，不因一行不合格就把快照扔掉。
 */
function readTodoList(details) {
  if (!isRecord(details) || !Array.isArray(details.todos)) return null;
  const todos = [];
  for (const item of details.todos) {
    if (!isRecord(item)) continue;
    const content = trim(typeof item.content === 'string' ? item.content : item.text);
    if (content === '') continue;
    let status = item.status;
    if (status === undefined && typeof item.done === 'boolean') {
      status = item.done ? 'completed' : 'pending';
    }
    if (!STATUS_SET.has(status)) continue;
    todos.push({ content, status });
  }
  return todos;
}

/** 工具结果文本（给模型看的快照）：首行 `任务 d/t`，其后 `[x] 内容` / `[ ] 内容`。 */
function renderSnapshot(todos) {
  return renderLines(todos, (item) => (item.status === 'completed' ? '[x]' : '[ ]')).join('\n');
}

/** widget 行（给 TUI/面板兜底解析看的）：首行 `任务 d/t`，其后 `☑|◐|☐ 内容`。 */
function renderWidget(todos) {
  return renderLines(todos, (item) => GLYPH[item.status]);
}

function renderLines(todos, marker) {
  const done = todos.filter((item) => item.status === 'completed').length;
  return [`任务 ${done}/${todos.length}`, ...todos.map((item) => `${marker(item)} ${item.content}`)];
}

/** 从会话里取最后一张快照：扫 toolResult 消息，toolName==='todo'，失败的结果跳过（last-write-wins）。 */
function latestFromSession(ctx) {
  let entries = [];
  try {
    entries = ctx?.sessionManager?.getEntries?.() ?? [];
  } catch {
    entries = [];
  }
  let latest = null;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'message') continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== 'toolResult') continue;
    if (message.toolName !== TOOL_NAME || message.isError === true) continue;
    const list = readTodoList(message.details);
    if (list !== null) latest = list;
  }
  return latest ?? [];
}

export default function piWebxTodoExtension(pi) {
  /** 当前任务表（内存态；session_start / session_tree 时从会话快照重建）。 */
  let todos = [];

  /** 刷新 widget：空表传 undefined 清掉（行格式必须能被 `todoItemsFromWidgetLines` 还原）。 */
  function syncWidget(ctx) {
    try {
      if (todos.length === 0) {
        ctx?.ui?.setWidget?.(WIDGET_KEY, undefined);
        return;
      }
      ctx?.ui?.setWidget?.(WIDGET_KEY, renderWidget(todos));
    } catch {
      // widget 是尽力而为的展示层，失败不能影响工具结果
    }
  }

  /** 会话启动 / 分支切换：从会话快照重建并刷新 widget。 */
  function rebuild(ctx) {
    todos = latestFromSession(ctx);
    syncWidget(ctx);
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: '任务',
    description: DESCRIPTION,
    promptSnippet: 'todo: 维护整张任务表（每次调用提交完整 todos，整表替换；三态 pending/in_progress/completed）',
    promptGuidelines: [
      'todo 每次调用都必须提交**整张表**（todos 数组）：它替换上一张表，没有部分更新、没有逐项编辑。',
      '开工前先把任务拆成「一项一步」写进 todos，再动手；不要边做边一项一项地追加。',
      '正在做的任务标 in_progress；顺序工作时**最多只标一项** in_progress（超过 1 项会被工具拒绝）。',
      '任务一完成就立刻把它标成 completed，不要攒到最后一起标。',
      '只有全部任务都完成了，才允许表里没有任何 in_progress。',
      '琐碎的单步任务不要用 todo（普通回复即可）。',
    ],
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = toTodoList(params?.todos);
      if (!result.ok) {
        // 校验失败走 content 文本（不抛异常），details 回填当前表：面板保持上一次被采纳的快照
        return {
          content: [
            {
              type: 'text',
              text: `todo 调用被拒绝：${result.error}。当前任务表未改动，请修正后重新提交整张表。`,
            },
          ],
          details: { todos: todos.map((item) => ({ ...item })) },
        };
      }

      todos = result.todos;
      syncWidget(ctx);
      return {
        content: [{ type: 'text', text: renderSnapshot(todos) }],
        details: { todos: todos.map((item) => ({ ...item })) },
      };
    },
  });

  // /todo：用户手动查看当前整表快照（旧扩展的命令行为，pi CLI 用户还在用）
  pi.registerCommand('todo', {
    description: '查看当前任务表',
    handler: async (_args, ctx) => {
      try {
        if (todos.length === 0) {
          ctx?.ui?.notify?.('还没有任务。可以让 AI 用 todo 工具写出任务表。', 'info');
          return;
        }
        ctx?.ui?.notify?.(renderSnapshot(todos), 'info');
      } catch {
        // 命令输出失败不影响会话
      }
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    rebuild(ctx);
  });

  pi.on('session_tree', async (_event, ctx) => {
    rebuild(ctx);
  });
}
