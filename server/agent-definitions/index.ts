/**
 * User-owned sub-agent definitions: the *configuration* store.
 *
 * This module is deliberately runtime-free: it imports pi's `getAgentDir()` and
 * the frozen shared contract, and nothing else from this app. Starting a child
 * agent is the runtime's job (`server/pi/host.ts`); deciding who may edit a
 * definition is the router's (`server/agent-definitions-routes.ts`).
 *
 * Guarantees, stated where they are enforced:
 *
 *   - **One file, one revision.** The whole file is versioned by `revision`;
 *     every write takes `expectedRevision` and fails 409 when the file moved
 *     under it. This is a *file-level* CAS, not a per-agent one.
 *   - **Single-process atomicity, honestly labelled.** Writes are serialized by
 *     an in-process queue keyed by the *canonical* path of the file — symlink
 *     aliases and `..` spellings of one physical file share a key, so two writers
 *     cannot both win a CAS — and land through `tmp + fsync + rename`.
 *     **Not covered:** a second pi-webx process, any external writer, hard links
 *     (a different realpath for the same inode), or a malicious actor racing the
 *     filesystem between the check and the rename. Nothing here pretends to be a
 *     cross-process transaction or a TOCTOU-safe lock.
 *   - **A corrupt file is never overwritten.** Bad JSON, an unknown
 *     `schemaVersion` or an entry that fails validation reads as a 500; the
 *     bytes on disk are left exactly as they were.
 *   - **No credentials, ever.** A definition has no auth field, and unknown keys
 *     in any request are rejected rather than dropped, so a client cannot smuggle
 *     one in (`id`, `revision`, `role`, `modelOverride`, …).
 *   - **Built-ins are merged, not stored.** Every response is
 *     `builtin (unless shadowed by a user definition of the same name) + user
 *     definitions`, built-ins first. They are read-only (`source: 'builtin'`,
 *     `readOnly: true`, PATCH/DELETE refused with 400) and **always enabled** —
 *     there is no enable switch, so the dispatch tool exists out of the box even
 *     with no user definition at all. That is a deliberate product behaviour, not
 *     a default that a later change may quietly flip. See `server/builtin-agents.ts`.
 *
 * Scope: this is an *application-level* permission surface (the settings UI and
 * `/api/agent-definitions`). It is not an OS sandbox and it does not isolate
 * users from each other — the bridge is single-user, loopback-only, and the file
 * is readable by anything running as the same OS user.
 *
 * Layout — one file per concern, this barrel is the module's public surface:
 *
 *   - `./policy.ts` — which tool names a definition may never allow.
 *   - `./validation.ts` — request-side field/definition validation.
 *   - `./merge.ts` — the stored shape, patch merge, post-merge and on-disk checks.
 *   - `./store.ts` — paths, atomic file I/O, the serializing queue and the store.
 */

export { RESTRICTED_AGENT_TOOL_DISPLAY_NAMES, isRestrictedAgentTool } from './policy';
export { AgentDefinitionError } from './validation';
export {
  AgentDefinitionStore,
  agentDefinitionsStore,
  type AgentDefinitionStoreOptions,
} from './store';
