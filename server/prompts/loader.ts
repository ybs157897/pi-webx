/**
 * 内置提示词统一读取口：`server/prompts/**` 下的 markdown 是产品自带提示词的唯一事实，
 * `builtin-agents.ts`（子智能体整体替换）与 `host.ts`（主会话追加身份段）都从这里取。
 * 来源、归类与同步规则见同目录 README.md。
 */
import { readFileSync } from 'node:fs';

const cache = new Map<string, string>();

/** 读取一个内置提示词文件（相对本目录），去掉尾部空白并按路径缓存。 */
export function builtinPrompt(relativePath: string): string {
  const hit = cache.get(relativePath);
  if (hit !== undefined) return hit;
  const text = readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/\s+$/, '');
  cache.set(relativePath, text);
  return text;
}

/**
 * 主会话身份段（小台人设 + 安全声明 + Harness 块，工作台为主）。host.ts 以
 * `appendSystemPromptOverride: (base) => [MAIN_IDENTITY_PROMPT, WORKBENCH_PROMPT, ...base]`
 * 追加在 pi 默认系统提示词之后，用户级 APPEND_SYSTEM.md（override 的 base）原样保留在最后。
 */
export const MAIN_IDENTITY_PROMPT = builtinPrompt('main/identity.md');

/** 主会话工作台感知段（模块/数据层/知识库契约/仓库纪律），紧跟身份段之后。 */
export const WORKBENCH_PROMPT = builtinPrompt('main/workbench.md');

/**
 * 子智能体提示词。内容与 `scripts/check-subagent-tool.ts` 冻结的 ZCode@872ad960 原文
 * 逐字节一致（含声明过的偏差），改动前先读 server/prompts/README.md 的同步规则。
 */
export const SUBAGENT_GENERAL_PURPOSE_PROMPT = builtinPrompt('subagent/general-purpose.md');
export const SUBAGENT_EXPLORE_PROMPT = builtinPrompt('subagent/explore.md');
export const SUBAGENT_NOTES = builtinPrompt('subagent/notes.md');
