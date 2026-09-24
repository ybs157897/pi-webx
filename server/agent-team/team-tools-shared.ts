/**
 * Team 工具面的**共享**部分：参数门禁、定义覆写拒绝、成员工具面求交、描述渲染与 SDK 包装。
 *
 * 从 `team-tools.ts` 拆出（拆分重构，行为不变）：编排者的 9 个工具与成员的 2 个工具都建在
 * 这些原语上，所以它们单独成文件；两个工具面各自留在自己的文件里。
 *
 * 两条边界写在这里，而不是靠调用方自觉：
 *
 *   1. **表单里没有身份字段。** `from`/`to`/`teamId`/`ownerMemberId` 都不在任何工具的参数
 *      列表里——它们由宿主可信上下文填。模型传了这些键会被 {@link rejectUnknownKeys} 拒绝，
 *      不是被忽略。
 *   2. **定义是唯一真值。** 覆写键（`model`/`systemPrompt`/`tools`/`maxTurns` …）一律拒绝
 *      （`TEAM_OVERRIDE_REJECTED`），因为那等于让模型自己造一个定义。
 *
 * 失败一律**抛出**（`TeamError`，带稳定 code）：SDK 只有 throw 才会把工具调用标成
 * `isError: true`，而返回结果会被当成成功——这与 `subagent` 工具同一条约定。
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import type { AgentDefinition, AgentDefinitionsResponse, AgentToolPolicy } from '../../src/shared/agent-definitions';
import {
  planToolSurface,
  type FrozenDefinition,
  type SubagentDispatchOutcome,
  type ToolSurface,
} from '../pi/subagent-tool';
import type { AgentTeamRuntime } from './team-runtime';
import {
  TEAM_ERROR_CODES,
  TEAM_ORCHESTRATOR_TOOL_NAMES,
  TEAM_WORKER_TOOL_NAMES,
  TeamError,
} from './team-types';

/** 定义字段的覆写键：出现即拒绝，理由要对模型说清楚，否则它会换个拼法再试一次。 */
const OVERRIDE_KEYS: readonly string[] = [
  'model', 'modelId', 'provider', 'providerId', 'thinkingLevel',
  'systemPrompt', 'prompt', 'tools', 'allowedTools', 'toolNames',
  'maxTurns', 'maxConcurrentInstances', 'color', 'injectAgentsMd',
];

/** 一次成员派发请求。宿主把它接到现有 worker 派发上（capacity/租约/取消都不变）。 */
export interface TeamDispatchRequest {
  readonly teamId: string;
  readonly memberId: string;
  readonly definition: FrozenDefinition;
  readonly instruction: string;
  readonly surface: ToolSurface;
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: ((note: string) => void) | undefined;
}

/** 编排者工具需要宿主提供的东西。全部注入，没有 import 宿主。 */
export interface OrchestratorTeamToolDeps {
  readonly teamId: string;
  readonly runtime: AgentTeamRuntime;
  /** 合并后的定义列表（内置 + 用户，同名遮蔽规则与 dispatch 一致）。 */
  readonly definitions: () => Promise<AgentDefinitionsResponse>;
  /** 编排者会话当前 active 的工具：成员工具面的天花板。 */
  readonly parentActiveTools: () => readonly string[];
  /** 排一个成员并跑到结束。失败抛错。 */
  readonly dispatch: (request: TeamDispatchRequest) => Promise<SubagentDispatchOutcome>;
}

/** 成员工具需要的身份：宿主在派发时绑定，模型无从提供。 */
export interface WorkerTeamToolDeps {
  readonly teamId: string;
  readonly memberId: string;
  readonly runtime: AgentTeamRuntime;
}

/**
 * 成员的工具面：定义自己的工具（按既有规则求交）∪ 两个成员工具，减掉全部编排工具。
 *
 * 「既有规则」就是 {@link planToolSurface}：`all` 以父会话 active 为上限，`selected` 仍须在
 * 父会话里有（只读豁免照旧），任何 dispatch/管理类名字一律先被排除。这里再补两条：
 * 9 个编排工具一个都不进成员会话，而两个成员工具一定在——成员要能更新自己任务、能给 lead 回信。
 */
export function planMemberToolSurface(
  policy: AgentToolPolicy,
  parentActiveTools: readonly string[],
): ToolSurface {
  const base = planToolSurface(policy, parentActiveTools);
  const requested = [...new Set(policy.mode === 'all' ? [...parentActiveTools] : [...policy.names])];
  const orchestrationRequested = requested.filter((name) => TEAM_ORCHESTRATOR_TOOL_NAMES.includes(name));
  const names = [
    ...base.toolNames.filter((name) => !TEAM_ORCHESTRATOR_TOOL_NAMES.includes(name)),
    ...TEAM_WORKER_TOOL_NAMES,
  ];
  return {
    toolNames: [...new Set(names)],
    excluded: [...new Set([...base.excluded, ...orchestrationRequested])],
    // 两个成员工具由宿主提供，不因「父会话没启用」而算缺失。
    unavailable: base.unavailable.filter((name) => !TEAM_WORKER_TOOL_NAMES.includes(name)),
  };
}

/**
 * Parameter gate: the **first** offending key decides the error, and the message
 * says which of the three kinds it is, so the model learns the rule instead of
 * guessing (`不可覆写的定义字段` / `宿主填写的身份字段` / `未知参数`).
 */
function rejectUnknownKeys(toolName: string, params: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TeamError(TEAM_ERROR_CODES.invalidArguments, `${toolName} 的参数必须是对象。`);
  }
  const record = params as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    if (OVERRIDE_KEYS.includes(key)) {
      throw new TeamError(
        TEAM_ERROR_CODES.overrideRejected,
        `${toolName} 的第 1 个违规键 ${key} 属于「不可覆写的定义字段」：模型不能覆写定义的模型/提示词/工具/轮数——`
        + '定义是唯一真值，要改请让用户在设置里改定义。',
        { key, kind: 'definition-field' },
      );
    }
    if (key === 'from' || key === 'to' || key === 'teamId' || key === 'ownerMemberId' || key === 'memberId') {
      throw new TeamError(
        TEAM_ERROR_CODES.overrideRejected,
        `${toolName} 的第 1 个违规键 ${key} 属于「宿主填写的身份字段」：身份与收件人由宿主上下文填写，模型不能指定。`,
        { key, kind: 'identity-field' },
      );
    }
    throw new TeamError(
      TEAM_ERROR_CODES.invalidArguments,
      `${toolName} 的第 1 个违规键 ${key} 属于「未知参数」：本工具只接受 ${allowed.join('、') || '（无参数）'}。`,
      { key, kind: 'unknown-argument' },
    );
  }
  return record;
}

export function requireString(toolName: string, value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TeamError(TEAM_ERROR_CODES.invalidArguments, `${toolName} 的 ${key} 必须是非空字符串。`, { key });
  }
  return value;
}

export function requireRevision(toolName: string, value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TeamError(TEAM_ERROR_CODES.invalidArguments, `${toolName} 的 ${key} 必须是 ≥1 的整数。`, { key });
  }
  return value;
}

export function stringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TeamError(TEAM_ERROR_CODES.invalidArguments, `${key} 必须是字符串数组。`, { key });
  }
  return [...value] as string[];
}

/**
 * The definition list `dispatch_agent`'s description carries.
 *
 * One line per **enabled** definition, and each line must let the model do three
 * things without another tool: name it (`definitionId`), recognise it (`name` +
 * one-line description) and echo a revision that is current (`revision`).
 *
 * What is deliberately absent, and why it must stay absent:
 *
 *   - **disabled definitions** — a dispatch would be refused, so listing them only
 *     invites a refusal;
 *   - **built-ins a same-named user definition shadowed** — the caller passes the
 *     *merged* list (`mergeBuiltinAndUserAgents`), where the shadowed builtin is
 *     already gone; this function must never re-add from the store;
 *   - **the orchestrator role itself** ({@link TEAM_ORCHESTRATOR_ROLE}) — it is not
 *     an `AgentDefinition`, is not dispatchable and is not user-editable.
 *
 * The list is only as fresh as the last refresh: `host.ts`'s `refreshTeamTools`
 * recomputes it on every prompt in team mode, which is what makes "revision from
 * this list" a safe thing to demand.
 */
export function renderDispatchAgentDescription(definitions: readonly AgentDefinition[]): string {
  const enabled = definitions.filter((definition) => definition.enabled);
  const lines = enabled.map((definition) => {
    const tools = definition.tools.mode === 'all' ? '继承父会话可用工具' : definition.tools.names.join(', ');
    const description = definition.description.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    return `- ${definition.id} (rev ${definition.revision}) — ${definition.name}：${description} [tools: ${tools || '无'}]`;
  });
  return [
    '把一个任务派给某个已启用的子智能体定义，并等它跑完。',
    'expectedDefinitionRevision 必须原样使用**下面清单里的** revision；不要复用上一轮的 revision，也不要复用 requestId：'
    + 'requestId 一经使用不可复用，重复使用会被拒绝（要再次派发请换新的 requestId）。',
    `revision 过期会返回 ${TEAM_ERROR_CODES.definitionRevisionStale}，请重新读取本清单后再派。`,
    '不接受 model/systemPrompt/tools/maxTurns 等覆写参数：定义是唯一真值，要改定义请让用户在设置里改。',
    '可用定义：',
    ...(lines.length === 0 ? ['（当前没有已启用的定义）'] : lines),
  ].join('\n');
}

/** 工具体拿到的宿主上下文：取消信号与增量更新回调。 */
export interface ToolBodyContext {
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: ((note: string) => void) | undefined;
}

/** 工具体的返回：文本走模型，details 走 SDK 面板。 */
export interface ToolBodyResult {
  readonly text: string;
  readonly details: Record<string, unknown>;
}

/** 把一个 team 工具包成 SDK 工具：参数门禁 + 文本/details 双通道 + 失败抛出。 */
export function teamTool(spec: {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: ToolDefinition['parameters'];
  readonly allowedKeys: readonly string[];
  readonly body: (args: Record<string, unknown>, ctx: ToolBodyContext) => Promise<ToolBodyResult>;
}): ToolDefinition {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const args = rejectUnknownKeys(spec.name, params, spec.allowedKeys);
      const note = onUpdate === undefined ? undefined : (text: string): void => {
        onUpdate({ content: [{ type: 'text', text }], details: {} });
      };
      const result = await spec.body(args, { signal, onUpdate: note });
      return { content: [{ type: 'text', text: result.text }], details: result.details };
    },
  };
}
