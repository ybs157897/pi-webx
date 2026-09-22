/**
 * Wire contract for user-defined sub-agents (`AgentDefinition`).
 *
 * The definition is the *configuration* half: it says what an agent may be
 * (name, prompt, model, tool policy, limits) and whether the user has enabled
 * it. It carries no credentials and no runtime state — a session started from a
 * definition is a separate object.
 *
 * Scope rules that the rest of the product must honour, stated here so the
 * backend, the UI and the dispatcher share one reading:
 *
 *   - **Definitions are user-owned.** CRUD is exposed on the native HTTP
 *     management surface (`/api/agent-definitions`) and in the settings UI
 *     only. No model-facing tool creates, edits or deletes a definition.
 *   - **`tools: { mode: 'all' }` is the default, and it means "every tool the
 *     parent already has", not "every tool that exists".** The effective set
 *     for an `all` child is the parent's active tools,
 *     minus `subagent` itself and any other dispatch/definition-management
 *     tool, so a child can never recurse into another dispatch. A parent on the
 *     `none` preset cannot dispatch at all. This is a *permission* bound, not a
 *     sandbox: `all` still lives inside whatever the parent may do.
 *   - **`tools: { mode: 'selected', names: [] }` is legal** and means pure
 *     reasoning with no tools; there is deliberately no minimum.
 *     Missing selected tools fail dispatch. Read-only `read/grep/find/ls` may
 *     be inactive in the parent but must still exist in the child registry.
 *     An `all` child may have fewer tools; the model-visible result names them.
 *   - **Model selection is `inherit` or an explicit `fixed` pair.** `inherit`
 *     follows the parent session; a `fixed` provider/model that cannot be
 *     resolved is an error, never a silent fallback.
 *   - **`expectedRevision` is a file-level CAS**, not a per-agent revision. It
 *     guards the whole definitions file against concurrent writers.
 *   - **No Team.** This contract has no Team, task board, mailbox or durable
 *     inbox concept. A dispatch returns an ordinary synchronous tool result.
 */

import type { PiThinkingLevel } from './protocol';

/** Tool allowance for a definition. `all` = whatever the parent may use. */
export type AgentToolPolicy = { mode: 'all' } | { mode: 'selected'; names: string[] };

/** Where the child's model comes from. `fixed` must resolve or the call fails. */
export type AgentModelSelection =
  | { mode: 'inherit' }
  | { mode: 'fixed'; providerId: string; modelId: string };

/**
 * The identity colours a definition may carry, in ZCode's order.
 *
 * A colour is a label the user picks, not a behaviour: nothing in the runtime
 * branches on it. It stays optional — a definition without one is normal, and
 * the UI is free to render it with a default swatch.
 */
export const SUBAGENT_COLORS = [
  'yellow',
  'red',
  'orange',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
] as const;

export type SubagentColor = (typeof SUBAGENT_COLORS)[number];

/** The user-editable half of a definition: what POST/PATCH accept. */
export interface AgentDefinitionInput {
  /** Trimmed; {@link MIN_AGENT_NAME_LENGTH}..{@link MAX_AGENT_NAME_LENGTH}
   *  Unicode code points matching {@link AGENT_NAME_PATTERN} (Unicode letters,
   *  Unicode digits and `-`). Non-ASCII names are allowed; uniqueness is
   *  case-insensitive. Historical names on disk are **not** re-checked. */
  name: string;
  /** At most {@link MAX_AGENT_DESCRIPTION_LENGTH} chars. The dispatcher reads
   *  this to decide which agent fits a task. */
  description: string;
  /** At most {@link MAX_AGENT_PROMPT_LENGTH} chars. */
  systemPrompt: string;
  model: AgentModelSelection;
  thinkingLevel?: PiThinkingLevel;
  tools: AgentToolPolicy;
  /** Optional identity colour. Absent means "unspecified", not "none". */
  color?: SubagentColor;
  /**
   * Whether the child's system prompt also carries the project's `AGENTS.md`
   * context files. Absent and `false` mean the same thing — the child runs
   * without them, which is the behaviour every existing definition already has.
   */
  injectAgentsMd?: boolean;
  maxTurns: number;
  maxConcurrentInstances: number;
  enabled: boolean;
}

/** A stored definition: the input plus server-owned identity and bookkeeping. */
export interface AgentDefinition extends AgentDefinitionInput {
  /** Server-assigned UUID. Immutable for the life of the definition. */
  id: string;
  /** Per-agent revision: 1 on create, +1 on every successful patch. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Where the definition comes from.
   *
   * `builtin` definitions ship with the product (see `server/builtin-agents.ts`),
   * are always `enabled`, and are never written to the definitions file. They can
   * be *shadowed*: a user definition with the same name replaces the builtin in
   * every listing.
   */
  source: 'builtin' | 'user';
  /**
   * Whether the management API refuses to change this definition.
   *
   * True exactly for `source: 'builtin'`. Derived, never stored: a definition on
   * disk does not carry it, and a request cannot set it. A UI should render such
   * a row as view-only — the tool policy, colour and prompt stay visible, and
   * there is no enable switch, because a builtin is always enabled.
   */
  readOnly: boolean;
}

/** Body of every successful read *and* write of the definitions file. */
export interface AgentDefinitionsResponse {
  schemaVersion: 1;
  /** File-level revision guarding the whole file; see `expectedRevision`. */
  revision: number;
  /** Absolute path of the file the server actually read/wrote. */
  path: string;
  agents: AgentDefinition[];
}

/** POST body. `expectedRevision` is the file revision the client last saw. */
export interface CreateAgentDefinitionRequest {
  expectedRevision: number;
  definition: AgentDefinitionInput;
}

/**
 * Fields a PATCH may change.
 *
 * Differs from `Partial<AgentDefinitionInput>` in one place: the properties that
 * can be **cleared**. JSON has no `undefined`, so "omit the key to keep the
 * stored value" and "send a value to replace it" leave no way back to *unset* a
 * property once it was ever set. `null` is that third state, for
 * `thinkingLevel` (fall back to the parent's level) and `color` (no colour):
 *
 *   - key **omitted** → keep the stored value unchanged;
 *   - a value → replace it with that value;
 *   - **`null`** → delete the property (`thinkingLevel`, `color` only).
 *
 * `null` is a PATCH-only signal. Stored definitions never carry it
 * ({@link AgentDefinitionInput.thinkingLevel} stays `PiThinkingLevel | undefined`,
 * {@link AgentDefinitionInput.color} stays `SubagentColor | undefined`).
 *
 * `injectAgentsMd` needs no `null`: `false` is itself a legal value, so the
 * boolean is written directly and an omitted key keeps whatever is stored.
 */
export type AgentDefinitionPatch = Omit<
  Partial<AgentDefinitionInput>,
  'thinkingLevel' | 'color'
> & {
  thinkingLevel?: PiThinkingLevel | null;
  color?: SubagentColor | null;
};

/** PATCH body. A `patch` of `{}` is a no-op read-back at the same revision. */
export interface UpdateAgentDefinitionRequest {
  expectedRevision: number;
  patch: AgentDefinitionPatch;
}

/** DELETE body: the file revision the client last saw. */
export interface DeleteAgentDefinitionRequest {
  expectedRevision: number;
}

/** One entry in the tool catalog the settings UI offers for `selected` mode. */
export interface AgentToolOption {
  name: string;
  description: string;
  source: 'builtin' | 'extension';
}

/** GET /api/agent-definitions/tools response. */
export interface AgentToolsResponse {
  tools: AgentToolOption[];
  /** True when the catalog depends on a session (extension tools are per-session). */
  sessionScoped: boolean;
  /** Tool names never offered, e.g. `subagent` and definition management. */
  excluded: string[];
}

/** Default turn budget for a new definition. */
export const DEFAULT_AGENT_MAX_TURNS = 8;
/** Default concurrency for a new definition. */
export const DEFAULT_AGENT_MAX_CONCURRENT_INSTANCES = 1;
/** The dispatch tool a parent calls; never offered to a child. */
export const SUBAGENT_TOOL_NAME = 'subagent';
/** Lower bound for {@link AgentDefinitionInput.name}, counted in code points. */
export const MIN_AGENT_NAME_LENGTH = 3;
/**
 * Upper bound for {@link AgentDefinitionInput.name}, counted in code points.
 *
 * The length and the copy for both name errors come from ZCode
 * (`SubagentsSection.tsx`), with one deliberate difference: the accepted
 * character class is **Unicode**, so a Chinese name of three characters is as
 * valid as `abc`. Spaces, underscores and other punctuation are still refused.
 */
export const MAX_AGENT_NAME_LENGTH = 50;
/**
 * What a name may contain: Unicode letters, Unicode digits and `-`.
 *
 * Enforced on **write** only. A file written before this rule existed may hold
 * names that would be refused today, and reading it must not fail — the store
 * reports what is stored instead of rejecting the user's own history.
 */
export const AGENT_NAME_PATTERN = /^[\p{L}\p{N}-]+$/u;
/** Upper bound for {@link AgentDefinitionInput.description}. */
export const MAX_AGENT_DESCRIPTION_LENGTH = 500;
/** Upper bound for {@link AgentDefinitionInput.systemPrompt}. */
export const MAX_AGENT_PROMPT_LENGTH = 32000;

/**
 * A blank definition for the settings UI's "new agent" form: empty text, inherit
 * the parent model, all tools, and **disabled** — an agent the user has not
 * switched on is never dispatched.
 *
 * Two fields are deliberately shaped here:
 *
 *   - `color` is **omitted** rather than set: "no colour chosen yet" is not a
 *     colour, and the form must be able to tell a chosen one from a default.
 *   - `injectAgentsMd` is written as `false`, the same thing an omitted key
 *     means, so the default is visible in the form's baseline instead of being
 *     implied. A child runs without the project's `AGENTS.md` unless the user
 *     asks for it.
 */
export function createEmptyAgentDefinition(): AgentDefinitionInput {
  return {
    name: '',
    description: '',
    systemPrompt: '',
    model: { mode: 'inherit' },
    tools: { mode: 'all' },
    injectAgentsMd: false,
    maxTurns: DEFAULT_AGENT_MAX_TURNS,
    maxConcurrentInstances: DEFAULT_AGENT_MAX_CONCURRENT_INSTANCES,
    enabled: false,
  };
}
