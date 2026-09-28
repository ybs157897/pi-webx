/**
 * 模块 Agent 的公共契约：身份、配置与装配产物的类型。
 *
 * 领域模块只依赖这里的类型，不互相 import；`profiles.ts` 产出
 * `ResolvedAgentProfile`，装配路径与 HTTP 路由只面对这组契约。
 */

export type AgentId = 'requirements' | 'codes' | 'logs';

export const AGENT_IDS: readonly AgentId[] = ['requirements', 'codes', 'logs'];

/** 一段模块会话的服务端身份；写进会话日志的自定义条目，先于首次模型调用落地。 */
export interface AgentScope {
  agentId: AgentId;
  workspaceKey: string;
  sessionId: string;
  profileRevision: string;
}

export type McpConnectionConfig = {
  id: string;
  enabled: boolean;
  required: boolean;
  connection:
    | {
        transport: 'stdio';
        command: string;
        args?: string[];
        cwd?: string;
        /** 只存环境变量名，真实值不进入配置与摘要。 */
        envRefs?: Record<string, string>;
      }
    | {
        transport: 'streamable-http';
        url: string;
        headerRefs?: Record<string, string>;
      };
  tools: string[];
  resources: boolean;
  timeoutMs: number;
};

export interface AgentProfileConfig {
  schemaVersion: 1;
  id: AgentId;
  enabled: boolean;
  promptFile: string;
  model?: { provider: string; id: string };
  skills: string[];
  tools: string[];
  mcp: McpConnectionConfig[];
  knowledge: { homeBinding: string; sharedReadBindings: string[] };
  limits: { maxRunningSessions: number; maxToolOutputChars: number };
}

export interface ResolvedAgentProfile {
  config: AgentProfileConfig;
  configPath: string;
  promptText: string;
  /** 绝对路径，已 stat 存在。 */
  skillPaths: string[];
  /** 含 config 规范化 JSON + prompt 正文 + 每个 SKILL.md 正文；不含任何 env 值。 */
  profileRevision: string;
}

export type ProfileLoadResult =
  | { ok: true; profile: ResolvedAgentProfile }
  | { ok: false; agentId: AgentId | null; file: string; error: string };
