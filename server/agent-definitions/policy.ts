/**
 * Which tool names a definition may never allow.
 *
 * Split out of the store (`server/agent-definitions/index.ts` carries the
 * module's guarantees): the runtime and the UI share one list, and it depends on
 * nothing but the frozen shared contract.
 */

import { SUBAGENT_TOOL_NAME } from '../../src/shared/agent-definitions';

/* -------------------------------------------------------------- tool policy */

/**
 * Names a definition may never allow.
 *
 * Everything that could start another agent, or manage definitions, is excluded
 * *by name* so the runtime and the UI share one list: a child that could
 * re-enter dispatch would recurse past every turn budget the parent set. Aliases
 * are listed explicitly because a caller — a model, a wheel, a hand-written
 * request — can spell dispatch several ways; none of them becomes an
 * authorization just by being declarable. A definition carries no role field,
 * and this list is what the runtime consults, not anything a tool caller says
 * about itself.
 *
 * Kept as data, not as an import from the runtime, so the store stays free of
 * runtime dependencies.
 */
const RESTRICTED_AGENT_TOOL_NAMES: readonly string[] = [
  SUBAGENT_TOOL_NAME,
  'agent',
  'subagent',
  'spawn_agent',
  'dispatch_agent',
  'spawn_teammate',
  'subagent_fork',
  'workflow',
];

/** Prefixes that cover families (`team_task*`, `agent_definition*` CRUD). */
const RESTRICTED_AGENT_TOOL_PREFIXES: readonly string[] = [
  'subagent',
  'spawn_agent',
  'dispatch_agent',
  'spawn_teammate',
  'team_task',
  'agent_definition',
];

/**
 * The same exclusion set as the UI should display it. Wildcards are shown so a
 * reader can tell a family from a single name; {@link isRestrictedAgentTool} is
 * the thing that decides.
 */
export const RESTRICTED_AGENT_TOOL_DISPLAY_NAMES: readonly string[] = [
  SUBAGENT_TOOL_NAME,
  'Agent',
  'subagent',
  'spawn_agent',
  'dispatch_agent',
  'spawn_teammate',
  'subagent_fork',
  'workflow',
  'team_task*',
  'agent_definitions*',
];

/**
 * Whether a tool name is a dispatch/definition-management name that a
 * definition may never enable.
 *
 * Case-insensitive, and an empty or blank name is restricted too — a blank tool
 * name is not something the runtime can resolve, and admitting it would let a
 * definition look configured while dispatching nothing.
 */
export function isRestrictedAgentTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (RESTRICTED_AGENT_TOOL_NAMES.includes(normalized)) return true;
  return RESTRICTED_AGENT_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
