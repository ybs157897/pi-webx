/**
 * The two built-in sub-agents, ported from ZCode's built-in profiles.
 *
 * Source of the prose: ZCode at `872ad960` (`apps/zcode-cli/packages/core/src/`),
 * `subagent/general-purpose.ts:7-24`, `subagent/explore.ts:20-68`,
 * `subagent/profile.ts:66-80`/`:115-130`, `subagent/system-prompt.ts:11-18`. With
 * exactly the deviations listed at {@link DECLARED_ZCODE_DEVIATIONS} — two in
 * Explore's prompt (our tool names; every Bash line gone) and one in Explore's
 * description (breadth is not a parameter) — the wording is kept **verbatim**, so
 * a user comparing the two products sees the same agent.
 *
 * Three things distinguish a builtin from a user definition, and all three are
 * enforced elsewhere (`server/agent-definitions.ts`):
 *
 *   - **Always enabled.** There is no enable switch, mirroring ZCode. Because the
 *     dispatch tool is registered whenever an enabled definition exists, the
 *     `subagent` tool is available out of the box, before the user has created
 *     anything — that is the behaviour the user chose.
 *   - **Always read-only.** `readOnly: true`, and PATCH/DELETE on a builtin id is
 *     refused with 400.
 *   - **Never on disk.** The definitions file holds only user definitions; these
 *     are merged in at read time. A user definition with the same *name* shadows
 *     the builtin, so "replace general-purpose with my own" needs no special
 *     case.
 *
 * These objects are frozen: a caller that mutated one would change the product's
 * built-ins for the whole process.
 */

import type { AgentDefinition } from '../src/shared/agent-definitions';

/** The id of the general-purpose builtin. Stable: it appears in dispatch calls. */
export const BUILTIN_GENERAL_PURPOSE_ID = 'builtin:general-purpose';
/** The id of the Explore builtin. Stable, for the same reason. */
export const BUILTIN_EXPLORE_ID = 'builtin:explore';

/**
 * Builtins have no creation record.
 *
 * The contract allows a constant timestamp or the empty string; this is the empty
 * string, because a real-looking date would be a lie about when the definition
 * appeared. Consumers must not render a date for `source: 'builtin'` — there is
 * nothing to show.
 */
export const BUILTIN_AGENT_TIMESTAMP = '';

/** One deliberate difference between our built-in prose and ZCode's. */
export interface ZCodeDeviation {
  /** Stable id; the check asserts the set of ids, so it cannot change silently. */
  readonly id: 'explore-prompt-tool-names' | 'explore-prompt-no-bash' | 'explore-description-breadth';
  /** The shipped field the deviation lands in. */
  readonly where: 'builtin:explore.systemPrompt' | 'builtin:explore.description';
  /** One line a reviewer can check against ZCode. */
  readonly summary: string;
  /** ZCode text → our text. Must match exactly once, in both directions. */
  readonly replacements: readonly { readonly from: string; readonly to: string }[];
}

/**
 * Every deliberate difference between our built-in prose and ZCode's — the whole
 * allowlist, and nothing outside it.
 *
 * The list is load-bearing, not documentation: `scripts/check-subagent-tool.ts`
 * keeps frozen copies of ZCode's originals, applies exactly these replacements,
 * and requires byte equality with what we ship. A silent fourth edit — or a
 * reworded "fix" to one of these three — fails the check instead of drifting.
 *
 * Deliberately **not** on the list, so still ZCode's word for word: both
 * `systemPrompt`s (including `You are an agent for ZCode CLI`), the shared
 * `Notes:` section, and general-purpose's `description`. Revisiting them is
 * future work, not a licence to edit them here.
 */
export const DECLARED_ZCODE_DEVIATIONS: readonly ZCodeDeviation[] = Object.freeze([
  Object.freeze({
    id: 'explore-prompt-tool-names',
    where: 'builtin:explore.systemPrompt',
    summary: "ZCode's `Glob`/`Grep`/`Read` become our `find`/`grep`/`read`, so the prompt names tools the child really has.",
    replacements: Object.freeze([
      Object.freeze({ from: '- Use Glob for broad file pattern matching', to: '- Use find for broad file pattern matching' }),
      Object.freeze({ from: '- Use Grep for searching file contents with regex', to: '- Use grep for searching file contents with regex' }),
      Object.freeze({ from: '- Use Read when you know the specific file path you need to read', to: '- Use read when you know the specific file path you need to read' }),
    ]),
  }),
  Object.freeze({
    id: 'explore-prompt-no-bash',
    where: 'builtin:explore.systemPrompt',
    summary: "ZCode's two `Bash` lines become one sentence, because our Explore has no shell at all.",
    replacements: Object.freeze([
      Object.freeze({
        from: '- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)\n'
          + '- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification',
        to: '- You have no Bash tool and no write tool of any kind: search and read, never change state',
      }),
    ]),
  }),
  Object.freeze({
    id: 'explore-description-breadth',
    where: 'builtin:explore.description',
    summary: 'ZCode says "Specify search breadth: …", but the `subagent` tool has no such parameter; ours says where breadth belongs.',
    replacements: Object.freeze([
      Object.freeze({ from: 'Specify search breadth:', to: 'State the intended breadth in the task text:' }),
    ]),
  }),
]);

/** The declared deviations that land in one shipped field, in declaration order. */
export function deviationsFor(where: ZCodeDeviation['where']): readonly ZCodeDeviation[] {
  return DECLARED_ZCODE_DEVIATIONS.filter((deviation) => deviation.where === where);
}

/**
 * The `Notes:` section ZCode appends to every sub-agent prompt
 * (`subagent/system-prompt.ts:11-18`), verbatim.
 *
 * It is appended to both builtins' prompts here rather than layered at dispatch
 * time, because pi-webx's worker takes the definition's prompt as the whole
 * system prompt.
 */
const SUBAGENT_NOTES = `Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.
- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.`;

/** ZCode `subagent/general-purpose.ts:7-24`, verbatim. */
const GENERAL_PURPOSE_PROMPT = `You are an agent for ZCode CLI. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

/**
 * ZCode `subagent/explore.ts:20-68` (the default, non-embedded-search branch),
 * with the prompt's two declared edits
 * ({@link DECLARED_ZCODE_DEVIATIONS} — the third lands in the description):
 *
 *   1. **Tool names are ours.** `Glob` → `find`, `Grep` → `grep`, `Read` → `read`,
 *      so the prompt names tools the child actually has.
 *   2. **Every Bash line is gone.** ZCode's Explore keeps `Bash` and leans on the
 *      prompt for read-only behaviour; ours has no shell at all, so the two
 *      "Use Bash ONLY…" / "NEVER use Bash for…" lines are replaced by one
 *      sentence stating that. (The contract wrote that sentence in Chinese as
 *      「你没有 Bash，也没有任何写工具」; the prompt is otherwise English, so the
 *      line is English here. Say the word and it becomes the Chinese text.)
 *
 * Everything else — the READ-ONLY declaration, strengths, the parallel-call note
 * and the closing line — is untouched. Note that ZCode's general-purpose prompt
 * carries the same `Use Read when you know the specific file path.` guideline in
 * *its* wording; that one is not on the list either, so it stays as ZCode wrote it.
 */
const EXPLORE_SYSTEM_PROMPT = `You are ZCode Explore, a file search and codebase research specialist for ZCode CLI. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use find for broad file pattern matching
- Use grep for searching file contents with regex
- Use read when you know the specific file path you need to read
- You have no Bash tool and no write tool of any kind: search and read, never change state
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`;

const GENERAL_PURPOSE_DESCRIPTION =
  'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.';

/**
 * The ZCode Explore description (`subagent/profile.ts:120-121`), verbatim except
 * for one sentence: ZCode ends it with `Specify search breadth: …`, which asks
 * the caller to pass a parameter the `subagent` tool does not have (its schema is
 * exactly `agentId` + `task`). A model following that sentence would try to send
 * a `breadth` argument and fail validation, so the sentence now tells it where
 * breadth belongs — in the task text. Wording, levels and the rest of the
 * sentence are unchanged.
 *
 * This is the third declared deviation from ZCode (see
 * {@link DECLARED_ZCODE_DEVIATIONS}); `scripts/check-subagent-tool.ts` pins all
 * three against the originals byte for byte.
 */
const EXPLORE_DESCRIPTION =
  'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. State the intended breadth in the task text: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.';

/** The system prompt both builtins ship: the profile's prose plus the Notes. */
function withNotes(prompt: string): string {
  return `${prompt}\n\n${SUBAGENT_NOTES}`;
}

/**
 * The built-in definitions, in display order (`general-purpose` first).
 *
 * Frozen, and typed as `readonly AgentDefinition[]`: the identity fields
 * (`id`, `revision`, `source`, `readOnly`) are what the store leans on, so they
 * must not be editable by a caller.
 */
export const BUILTIN_AGENT_DEFINITIONS: readonly AgentDefinition[] = Object.freeze([
  Object.freeze({
    id: BUILTIN_GENERAL_PURPOSE_ID,
    name: 'general-purpose',
    description: GENERAL_PURPOSE_DESCRIPTION,
    systemPrompt: withNotes(GENERAL_PURPOSE_PROMPT),
    model: { mode: 'inherit' },
    tools: { mode: 'all' },
    color: 'blue',
    injectAgentsMd: true,
    maxTurns: 4,
    maxConcurrentInstances: 1,
    enabled: true,
    revision: 1,
    createdAt: BUILTIN_AGENT_TIMESTAMP,
    updatedAt: BUILTIN_AGENT_TIMESTAMP,
    source: 'builtin',
    readOnly: true,
  } satisfies AgentDefinition),
  Object.freeze({
    id: BUILTIN_EXPLORE_ID,
    name: 'Explore',
    description: EXPLORE_DESCRIPTION,
    systemPrompt: withNotes(EXPLORE_SYSTEM_PROMPT),
    model: { mode: 'inherit' },
    // Read-only in the tool policy, not merely in prose: no bash, no write tool.
    tools: { mode: 'selected', names: ['read', 'grep', 'find', 'ls'] },
    color: 'cyan',
    injectAgentsMd: false,
    maxTurns: 4,
    maxConcurrentInstances: 1,
    enabled: true,
    revision: 1,
    createdAt: BUILTIN_AGENT_TIMESTAMP,
    updatedAt: BUILTIN_AGENT_TIMESTAMP,
    source: 'builtin',
    readOnly: true,
  } satisfies AgentDefinition),
]);

/** Whether an id belongs to a built-in definition (and is therefore read-only). */
export function isBuiltinAgentId(id: string): boolean {
  return BUILTIN_AGENT_DEFINITIONS.some((definition) => definition.id === id);
}

/** Name comparison for shadowing: NFKC + case-fold, the same key the store uses. */
function nameKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/**
 * Built-ins plus user definitions, built-ins first.
 *
 * A user definition whose name matches a builtin **shadows** it: the builtin is
 * left out entirely, so a user who wants a different `general-purpose` writes
 * their own with that name and never sees the shipped one. This is ZCode's
 * `normalizeAgentProfiles` behaviour (built-ins into a map first, user profiles
 * overriding by name).
 */
export function mergeBuiltinAndUserAgents(
  userAgents: readonly AgentDefinition[],
): AgentDefinition[] {
  const shadowed = new Set(userAgents.map((agent) => nameKey(agent.name)));
  const kept = BUILTIN_AGENT_DEFINITIONS.filter(
    (definition) => !shadowed.has(nameKey(definition.name)),
  );
  return [...kept, ...userAgents];
}
