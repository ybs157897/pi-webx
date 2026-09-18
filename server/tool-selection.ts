/**
 * The session's tool selection — pi-web's permission model, ported.
 *
 * Two facts from `agegr/pi-web` shape this file, and both are worth keeping
 * because they are what make the selection behave sanely:
 *
 *   1. **A preset never disables extension tools.** pi-web applies a selection as
 *      `withExtensionTools(...)`: the chosen builtin names plus every tool that is
 *      not a coding tool. Without that merge, picking "只读" would also switch off
 *      tools an extension registered (this app's own `render_ui`, for one), which
 *      is not what the user asked for. `none` is the deliberate exception — it
 *      means chat-only, so it passes an empty list through untouched.
 *   2. **The selection is durable per session**, written as a versioned custom
 *      entry (`pi-web:tool-selection` there, `pi-webx:tool-selection` here) rather
 *      than as a browser preference alone. Reopening a session restores the tools
 *      it was last run with; a preference only decides what a *new* session starts
 *      from. dsh keeps session-scoped tool choices in a versioned custom entry for
 *      the same reason.
 *
 * The bash/powershell resolution is pi-web's too: on Windows, when settings name
 * powershell as the default shell tool, a selection mentioning bash means
 * powershell.
 */

import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

import { BUILTIN_TOOL_NAMES } from '../src/shared/tool-presets';

/** The custom-entry type this app writes, versioned so a shape change is readable. */
export const TOOL_SELECTION_TYPE = 'pi-webx:tool-selection';

const CODING_TOOL_NAMES = new Set(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);

/** One entry as the session manager hands it back (only the fields read here). */
interface CustomEntry {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

/** Whether settings name powershell as this platform's shell tool. */
export function usesPowerShell(
  defaultTools: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === 'win32' &&
    defaultTools?.includes('powershell') === true &&
    !defaultTools.includes('bash')
  );
}

/** Rewrite every shell mention to the platform's shell tool. */
export function replaceShellTool(toolNames: readonly string[], powerShell: boolean): string[] {
  const shell = powerShell ? 'powershell' : 'bash';
  const result: string[] = [];
  for (const name of toolNames) {
    const next = SHELL_TOOLS.has(name) ? shell : name;
    if (!result.includes(next)) result.push(next);
  }
  return result;
}

/**
 * The names to actually enable: the selection resolved for this platform, plus
 * every extension tool. An empty selection stays empty on purpose (chat-only).
 */
export function withExtensionTools(
  session: Pick<AgentSession, 'getAllTools'>,
  toolNames: readonly string[],
  defaultTools: readonly string[] | undefined,
): string[] {
  if (toolNames.length === 0) return [];
  const selected = replaceShellTool(toolNames, usesPowerShell(defaultTools));
  const extensionToolNames = session
    .getAllTools()
    .map((tool) => tool.name)
    .filter((name) => !CODING_TOOL_NAMES.has(name));
  return [...new Set([...selected, ...extensionToolNames])];
}

/** Accept only builtin names, deduplicated — pi-web validates the same way. */
export function validateToolSelection(tools: unknown): string[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  if (tools.some((tool) => typeof tool !== 'string' || !BUILTIN_TOOL_NAMES.has(tool))) return undefined;
  return [...new Set(tools as string[])];
}

/**
 * The newest valid persisted selection, or `undefined` for a session that never
 * recorded one — which is how a resumed transcript is told from a fresh one.
 */
export function readToolSelection(entries: readonly unknown[]): string[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as CustomEntry | undefined;
    if (entry === undefined || entry.type !== 'custom' || entry.customType !== TOOL_SELECTION_TYPE) {
      continue;
    }
    const data = entry.data as { version?: unknown; tools?: unknown } | undefined;
    if (data === undefined || data.version !== 1) continue;
    const tools = validateToolSelection(data.tools);
    if (tools !== undefined) return tools;
  }
  return undefined;
}

/** Record the selection so reopening the session restores it. */
export function appendToolSelection(
  sessionManager: Pick<SessionManager, 'appendCustomEntry'>,
  tools: readonly string[],
): void {
  sessionManager.appendCustomEntry(TOOL_SELECTION_TYPE, { version: 1, tools: [...tools] });
}
