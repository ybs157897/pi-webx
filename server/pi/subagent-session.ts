/** SDK session composition. No scheduling or host session registry access. */
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ModelRuntime, type ExtensionUIContext, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import type { FrozenDefinition } from './subagent-tool';
import { SubagentRunError } from './subagent-error';
import type { SubagentUiOrigin } from '../../src/shared/protocol';
import type { ExtensionUiScope } from './extension-ui';
import { createIsolatedToolDefinitions } from '../agent-team/sandbox-tools';
import { ensureWindowsAppContainerVerified } from '../agent-team/windows-appcontainer';

/**
 * The parent surface one dispatch reads.
 *
 * Structural rather than `AgentSession` so a test can drive a dispatch without a
 * real session; the host passes a real one, which satisfies it.
 */
export interface WorkerParentSession {
  readonly model: AgentSession['model'];
  readonly thinkingLevel: AgentSession['thinkingLevel'];
  readonly settingsManager: SettingsManager;
  getAllTools(): readonly { readonly name: string }[];
}

/** The live parent a worker is dispatched from. Read at dispatch time — reset replaces the session. */
export interface SubagentParentContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly session: WorkerParentSession;
  readonly createUiScope?: (origin: SubagentUiOrigin, signal: AbortSignal) => ExtensionUiScope;
}

/** Keep both layers in memory; the SDK owns their merge and migration rules. */
export function createWorkerSettings(manager: SettingsManager): SettingsManager {
  const stored = {
    global: JSON.stringify(manager.getGlobalSettings()),
    project: JSON.stringify(manager.getProjectSettings()),
  };
  return SettingsManager.fromStorage({
    withLock(scope, update) {
      const next = update(stored[scope]);
      if (next !== undefined) stored[scope] = next;
    },
  }, { projectTrusted: manager.isProjectTrusted() });
}

/** Resolve the model a worker must run on, or refuse loudly. */
export function resolveWorkerModel(
  definition: FrozenDefinition,
  parent: WorkerParentSession,
  runtime: Pick<ModelRuntime, 'getModel' | 'hasConfiguredAuth'>,
): Model<any> {
  if (definition.model.mode === 'inherit') {
    const inherited = parent.model;
    if (inherited === undefined) {
      throw new SubagentRunError('invalid-model', '父会话当前没有模型，无法继承；请为该子智能体配置固定模型。');
    }
    return inherited;
  }
  const { providerId, modelId } = definition.model;
  const wanted = `${providerId}/${modelId}`;
  const resolved = runtime.getModel(providerId, modelId);
  if (resolved === undefined || resolved.provider !== providerId || resolved.id !== modelId) {
    throw new SubagentRunError(
      'invalid-model',
      `子智能体「${definition.name}」配置的模型 ${wanted} 不存在。`
      + '固定模型失效时不会回退到父模型，请在设置里修正或改为继承。',
    );
  }
  if (!runtime.hasConfiguredAuth(providerId)) {
    throw new SubagentRunError(
      'invalid-model',
      `子智能体「${definition.name}」配置的模型 ${wanted} 没有可用凭据，请先登录该 provider。`,
    );
  }
  return resolved;
}

export interface WorkerSessionOptions {
  readonly definition: FrozenDefinition;
  readonly parent: SubagentParentContext;
  readonly model: Model<any>;
  readonly runtime: ModelRuntime;
  readonly toolNames: readonly string[];
  readonly denied: readonly string[];
  readonly signal?: AbortSignal;
  readonly uiContext?: ExtensionUIContext;
  /**
   * The only host-side Team tools a worker may register on top of its allowlist.
   *
   * This seam exists for exactly one caller: the Agent Team runtime, which hands a
   * member its two team tools (`update_team_task` — its own task only — and
   * `send_team_message` — to the lead only). Everything else must stay out:
   * **dispatch or configuration tools may never be injected here.** A worker able to
   * register `dispatch_agent`/`subagent`/definition management would be exactly the
   * recursion this module refuses.
   *
   * What actually keeps them out is the `tools:` allowlist, not this field: that
   * allowlist filters custom tools **too**, so a name passed here which the allowlist
   * does not carry never reaches the registry at all. The SDK references and the
   * verifier's four-way control are with the activation note in `createWorkerSession`
   * below (`:176-195`); `denied` is the second veto on top of it.
   *
   * Omitted in the ordinary subagent path. Team isolation separately registers
   * sandboxed replacements for the built-in coding tools.
   */
  readonly memberTools?: readonly ToolDefinition[];
  /** Replace built-in coding tools with sandboxed subprocess calls for Team members. */
  readonly isolateCodingTools?: boolean;
}

/**
 * Build one worker session, fully assembled before it can run anything.
 *
 * The parent's transcript is never seeded: the child starts from an empty
 * in-memory log plus its own system prompt.
 */
export async function createWorkerSession(options: WorkerSessionOptions): Promise<AgentSession> {
  const { definition, parent, model, runtime, toolNames, denied } = options;
  options.signal?.throwIfAborted();
  if (options.isolateCodingTools === true && process.platform === 'win32') {
    await ensureWindowsAppContainerVerified(parent.cwd, parent.agentDir);
  }
  const isolatedTools = options.isolateCodingTools === true
    ? createIsolatedToolDefinitions(parent.cwd, parent.agentDir)
    : [];
  const settings = createWorkerSettings(parent.session.settingsManager);
  const loader = new DefaultResourceLoader({
    cwd: parent.cwd,
    agentDir: parent.agentDir,
    settingsManager: settings,
    // Extensions load (they are the source of the parent's extension tools);
    // skills, prompt templates and themes do not, because the worker's prompt is
    // its definition plus cwd metadata.
    noSkills: true,
    noExtensions: options.isolateCodingTools === true,
    noPromptTemplates: true,
    noThemes: true,
    // `noContextFiles` is the SDK's switch for the project's `AGENTS.md` files
    // (`resource-loader.js`: `noContextFiles ? [] : loadProjectContextFiles(...)`;
    // there is no finer AGENTS.md-only flag). Off by default: a definition runs
    // with its own prompt, and only `injectAgentsMd: true` adds the same context
    // files the parent session would see.
    //
    // This is context, not authority: the injected text is whatever `AGENTS.md`
    // says in the parent's cwd, and it grants no tool, path or permission the
    // child did not already have — and it is not the parent's conversation, which
    // the child still never receives.
    noContextFiles: definition.injectAgentsMd !== true,
    systemPromptOverride: () => definition.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  options.signal?.throwIfAborted();

  const { session } = await createAgentSession({
    cwd: parent.cwd,
    agentDir: parent.agentDir,
    model,
    thinkingLevel: definition.thinkingLevel ?? parent.session.thinkingLevel,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(parent.cwd),
    settingsManager: settings,
    resourceLoader: loader,
    tools: [...toolNames],
    excludeTools: [...denied],
    // Ordinary subagents register no custom tools. Team members add two
    // identity-bound Team tools and isolated replacements for coding tools;
    // no parent tool closure or dispatch tool is proxied into a member.
    customTools: [...(options.memberTools ?? []), ...isolatedTools],
  });
  const abort = (): void => { void session.abort().catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    const refused = async (): Promise<never> => { throw new Error('子智能体不能替换或重载宿主会话。'); };
    await session.bindExtensions({
      ...(options.uiContext === undefined ? {} : { uiContext: options.uiContext }),
      mode: options.uiContext === undefined ? 'print' : 'rpc',
      abortHandler: abort,
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: refused, fork: refused, switchSession: refused, navigateTree: refused, reload: refused,
      },
    });
    options.signal?.throwIfAborted();
    /**
     * Insurance, not the mechanism. The reason this used to claim ("a custom tool
     * is not subject to `tools:`") was backwards; the SDK's own behaviour, checked
     * by the independent verifier against `dist/core/agent-session.js`:
     *
     *   - `isAllowedTool` (`agent-session.js:2100-2112`) filters **custom tools by
     *     the `tools:` allowlist too**. A member tool whose name is not in that
     *     allowlist is not merely inactive — it never reaches the registry at all,
     *     so no amount of later activation can revive it.
     *   - `:2153-2159` re-activates allowlisted **registered** names when the
     *     runtime is rebuilt (which `bindExtensions` does).
     *
     * So the load-bearing requirement is that both member tool names stay in
     * `toolNames` (the `tools:` allowlist); the verifier's four-way control
     * confirmed that with the names listed they are active and callable without
     * this block. What follows is therefore redundant under the current allowlist
     * and kept only as a guard against a future runtime that stops auto-activating
     * registered names. `denied` still vetoes every orchestration name, and the
     * names added here are exactly the ones the caller passed.
     */
    if (options.memberTools !== undefined && options.memberTools.length > 0) {
      const active = new Set(session.getActiveToolNames());
      for (const tool of options.memberTools) active.add(tool.name);
      session.setActiveToolsByName([...active]);
    }
    return session;
  } catch (error) {
    await disposeWorkerSession(session);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

/** Extension resources are released before the SDK invalidates their context. */
export async function disposeWorkerSession(session: {
  dispose(): void;
  readonly extensionRunner?: AgentSession['extensionRunner'];
}): Promise<void> {
  try {
    await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    session.dispose();
  }
}
