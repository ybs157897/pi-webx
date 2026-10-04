/**
 * Explore codemode 试点：pi 1.0 `codemode` 工具在普通子代理链路的宿主显式授权。
 *
 * 这里是唯一的 SDK 运行时入口（`createCodemodeExtension`），其余接线文件只拿
 * 类型。授权语义：`codemode` 进入 explore 子会话不是因为只读豁免，而是宿主在
 * 普通派发入口按「稳定 ID + 试点开关」显式授予——用户自定义定义里写一个
 * `codemode` 依旧被拒，Team 与 `tools: all` 路径永远拿不到授予。
 *
 * 已知且接受的运行时例外（不是零落盘）：
 *   - codemode 脚本输出超过估算预算时，SDK 会把全文写到 `os.tmpdir()` 的
 *     `pi-codemode-*.txt`（`execute.js` 的 `spillOutput`），且文本在截断前先在
 *     宿主内存累积——返回预算既不是宿主内存上限，也不是落盘文件大小上限。
 *   - 四个直调工具（read/grep/find/ls）本身没有工作区路径沙箱，脚本经它们
 *     可达的路径与直调相同，试点不构成资源沙箱；宿主上限只封顶嵌套调用次数。
 */

import { createCodemodeExtension, type ExtensionFactory } from '@earendil-works/pi-coding-agent';

import { BUILTIN_EXPLORE_ID } from '../builtin-agents';
import type { AgentToolPolicy } from '../../src/shared/agent-definitions';

/** 试点开关：仅 `PI_EXPLORE_CODEMODE=1` 时对内置 explore 生效。 */
export const EXPLORE_CODEMODE_ENV = 'PI_EXPLORE_CODEMODE';
/** pi 1.0 codemode 工具名；SDK 侧注册 `defaultActive: false`，靠白名单激活。 */
export const CODEMODE_TOOL_NAME = 'codemode';

/**
 * 宿主对一次派发内嵌套工具调用的硬上限。
 *
 * SDK 的 `nestedCalls.maxCalls = 256` 只是记录截断限制，不限制执行；轮数预算
 * 与 120 秒生命周期也不能封顶一次脚本内的并发洪泛（嵌套 read 在宿主侧整读
 * 文件后才应用 offset/limit）。96 ≈ explore 基线（4 轮 × 每轮一批调用）的
 * 三倍余量，超限即拒绝该次及之后的每次嵌套调用（不终止派发本身）。
 */
export const CODEMODE_NESTED_CALL_LIMIT = 96;

/**
 * 只认宿主显式授予的子会话工具名。
 *
 * `codemode` 的可达性不应随「父会话恰好激活了它」外溢：`selected` 定义没拿到
 * 授予就要不到它，`all` 也不从父激活集继承它。不放进 restricted 名单——那会
 * 连合法授予一起排除。
 */
export const HOST_EXCLUSIVE_CHILD_TOOLS: ReadonlySet<string> = new Set([CODEMODE_TOOL_NAME]);

export function exploreCodemodeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EXPLORE_CODEMODE_ENV] === '1';
}

/** 嵌套调用计数器顺手采集的试点观测值；成功进 details，失败折叠进错误消息。 */
export interface CodemodePilotStats {
  /** 模型直接发起的 codemode 调用数（采用率分子）。 */
  outerCodemodeCalls: number;
  /** 脚本发起的嵌套工具调用数（被拒的也计）。 */
  nestedToolCalls: number;
  /** 被宿主上限拒绝的调用数。 */
  blockedCalls: number;
  /** 模型直调的非 codemode 工具调用数（A/B 对照臂）。 */
  directToolCalls: number;
}

/**
 * 计数器即守卫：`tool_call` 钩子在工具执行前触发且可阻塞，`parentToolCallId`
 * 只在脚本发起的调用上出现。超限后返回 block——计数只增不减，所以后续每次
 * 嵌套调用都会再次命中上限，一次拒绝即封顶本次派发的执行。
 *
 * 注意这**不会**结束派发本身：pi 的 `terminate` 提示只在外层工具批次自己的
 * 结果上生效（agent-loop 的 `shouldTerminateToolBatch` 要求该批所有结果都带
 * 它），而 codemode 把嵌套结果折叠成脚本值、不向上传播该标记——脚本可以
 * 捕获 block 错误继续跑，回合也会照常进入下一轮。派发的终止仍由轮数预算、
 * 120 秒生命周期与累计封顶这三个外层约束保证。
 */
function createNestedCallGuard(stats: CodemodePilotStats, limit: number): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (event.parentToolCallId === undefined) {
        if (event.toolName === CODEMODE_TOOL_NAME) stats.outerCodemodeCalls += 1;
        else stats.directToolCalls += 1;
        return undefined;
      }
      stats.nestedToolCalls += 1;
      if (stats.nestedToolCalls > limit) {
        stats.blockedCalls += 1;
        return {
          block: true,
          reason: `codemode 试点：单次派发的嵌套工具调用超过宿主上限 ${limit}，已拒绝。`,
        };
      }
      return undefined;
    });
  };
}

/** 一次派发的试点授予：授权名、要挂进子会话的扩展工厂、以及观测计数器。 */
export interface ExploreCodemodeGrant {
  /** 追加进 explore 定义工具面的名字（定义本身保持冻结的四工具不动）。 */
  readonly toolName: typeof CODEMODE_TOOL_NAME;
  /** 传给 `planToolSurface` 的宿主显式授予；不进只读豁免名单。 */
  readonly hostGrantedTools: readonly string[];
  /** 传给 worker loader 的扩展工厂；守卫在前，codemode 在后。 */
  readonly extensionFactories: readonly ExtensionFactory[];
  /** 派发期间累积，返回时读取。 */
  readonly stats: CodemodePilotStats;
}

/**
 * 唯一的资格判定点（普通派发入口调用一次，之后只传结果）：
 * 开关开 + 内置 explore + `selected` 工具面三者同时成立才授予。
 * Team 复用同一份 explore 定义但不经过这里，因此永远拿不到。
 */
export function exploreCodemodeGrant(
  definition: { readonly id: string; readonly tools: AgentToolPolicy },
  enabled: boolean,
): ExploreCodemodeGrant | undefined {
  if (!enabled || definition.id !== BUILTIN_EXPLORE_ID || definition.tools.mode !== 'selected') {
    return undefined;
  }
  const stats: CodemodePilotStats = {
    outerCodemodeCalls: 0, nestedToolCalls: 0, blockedCalls: 0, directToolCalls: 0,
  };
  return {
    toolName: CODEMODE_TOOL_NAME,
    hostGrantedTools: [CODEMODE_TOOL_NAME],
    extensionFactories: [
      createNestedCallGuard(stats, CODEMODE_NESTED_CALL_LIMIT),
      // models:false 关掉脚本直连模型注册表的旁路（分类器/图像生成不经工具白名单）；
      // mode:'on' 显式钉死，防父 settings 里 codemode.mode:'only' 经 worker 继承后
      // 隐藏 direct 工具声明。
      createCodemodeExtension({ models: false, mode: 'on' }),
    ],
    stats,
  };
}

/** 失败路径也带得走的一行有界摘要（进错误消息的 key=value 字段）。 */
export function codemodeStatsSummary(stats: CodemodePilotStats): string {
  return `outer=${stats.outerCodemodeCalls},nested=${stats.nestedToolCalls}`
    + `,blocked=${stats.blockedCalls},direct=${stats.directToolCalls}`;
}
