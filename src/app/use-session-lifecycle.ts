/**
 * 会话的生命周期与写入路径：打开既有会话、首条消息时的懒创建、模型与推理等级的
 * 写入（同时记下部署默认），以及提示发送与 composer 适配。
 *
 * 这一节是「浏览器动作 → pi 命令」的收口：发送走 `guardedPrompt`（无会话先创建），
 * 模型/推理等级的写入同时落到 pi 的部署默认上，composer 拿到的 api 就是这一层的
 * 组装结果。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { api as bridge } from '../lib/api';
import { modelCatalogApi } from '../lib/modelCatalog';
import { savePrefs } from '../lib/storage';
import type { PiSessionApi } from '../lib/usePiSession';
import { readToolPresetPreference } from '../components/ToolPresetSelect';
import type { PiCommandEnvelope, PiRpcResponse, PiThinkingLevel } from '../shared/protocol';
import { toolNamesForPreset, type ToolPreset } from '../shared/tool-presets';
import { errorText, failedPrompt } from './connection';
import type { ShellState } from './use-shell-state';
import type { SessionRuntime } from './use-session-runtime';

/** Result of the lazy first-send session creation. */
type CreateOutcome = { id: string } | { error: string };

export type SessionLifecycle = ReturnType<typeof useSessionLifecycle>;

export function useSessionLifecycle(state: ShellState, session: PiSessionApi, runtime: SessionRuntime) {
  const {
    sessionId, setSessionId, cwd, setCwd,
    newSessionMode, setNewSessionMode, setMobileSidebarExpanded,
    setBootError, setCatalog, setPendingModel,
  } = state;
  const { defaultModel, activeSelection, refreshSessions } = runtime;

  /**
   * Opens an existing pi session — the resume path from the sidebar, which has
   * to run immediately because there is a transcript to show. Fresh sessions
   * are *not* created here: they materialize on the first send (guardedPrompt),
   * so merely launching the app leaves no empty transcript behind.
   */
  const openSession = useCallback(
    async (target: string, sessionPath: string) => {
      try {
        const result = await bridge.createSession({ cwd: target, sessionPath });
        setMobileSidebarExpanded(false);
        setNewSessionMode('chat');
        setSessionId(result.session.id);
        setCwd(result.session.cwd);
        setBootError(null);
        savePrefs({ cwd: result.session.cwd });
        await refreshSessions();
      } catch (cause) {
        setBootError(errorText(cause));
      }
    },
    [refreshSessions],
  );

  /**
   * In-flight lazy creation, shared by concurrent sends so a double-click
   * cannot spawn two sessions. Only the promise is cached (not the id): it is
   * dropped as soon as the shell re-renders with a session, and a failed
   * attempt is dropped at once so the next send retries.
   */
  const pendingCreate = useRef<Promise<CreateOutcome> | null>(null);

  useEffect(() => {
    pendingCreate.current = null;
  }, [sessionId]);

  const ensureSession = useCallback((): Promise<CreateOutcome> => {
    if (pendingCreate.current) return pendingCreate.current;
    const pending = (async (): Promise<CreateOutcome> => {
      try {
        const result = await bridge.createSession({
          // No cwd yet means the config never loaded; let the bridge default it.
          ...(cwd.length > 0 ? { cwd } : {}),
          ...(defaultModel ? { provider: defaultModel.provider, model: defaultModel.id } : {}),
          // pi-web's split: the browser preference decides what a new session
          // starts from, and the session records it from there on.
          toolNames: toolNamesForPreset(readToolPresetPreference()),
          ...(newSessionMode === 'team' ? { teamMode: true } : {}),
        });
        setSessionId(result.session.id);
        setCwd(result.session.cwd);
        savePrefs({ cwd: result.session.cwd });
        await refreshSessions();
        return { id: result.session.id };
      } catch (cause) {
        pendingCreate.current = null;
        return { error: errorText(cause) };
      }
    })();
    pendingCreate.current = pending;
    return pending;
  }, [cwd, defaultModel, newSessionMode, refreshSessions]);

  /** Failed response for a local guard, shaped like a pi response. */
  const refused = useCallback(
    (command: string, error: string): PiRpcResponse => ({
      type: 'response',
      command,
      success: false,
      error,
    }),
    [],
  );

  /**
   * Picker write path, following dsh's `session.selectModel`: the choice applies
   * to the addressed session *and* is recorded as the deployment default, so the
   * next blank session starts from it. A failed default write is reported as a
   * notification but does not undo the session's selection — dsh logs it for the
   * same reason, and the session is already running the chosen model.
   */
  const applyModel = useCallback<PiSessionApi['setModel']>(
    async (provider, modelId) => {
      if (sessionId !== null) {
        const response = await session.setModel(provider, modelId);
        if (!response.success) return response;
      }
      // Recorded before the (async) settings write so picking and sending in one
      // gesture cannot race it: the created session reads this, not the file.
      setPendingModel({ provider, id: modelId });
      try {
        setCatalog(
          await modelCatalogApi.saveDefault({
            provider,
            model: modelId,
            ...(cwd.length > 0 ? { cwd } : {}),
          }),
        );
      } catch (cause) {
        session.notify('warning', '默认模型未保存', errorText(cause));
      }
      return { type: 'response', command: 'set_model', success: true };
    },
    [cwd, session, sessionId],
  );

  /**
   * Thinking-level write, same shape: apply to the session when there is one, and
   * remember the level against the selected model. pi keys that memory
   * `provider/model`, so a level can never be inherited by a model that rejects
   * it — the property dsh reaches by clearing a stored effort on a model change.
   */
  const applyThinkingLevel = useCallback<PiSessionApi['setThinkingLevel']>(
    async (level: PiThinkingLevel | null) => {
      if (level !== null && sessionId !== null) {
        const response = await session.setThinkingLevel(level);
        if (!response.success) return response;
      }
      if (activeSelection === null) {
        return refused('set_thinking_level', '请先选择模型');
      }
      try {
        // `null` clears the remembered level (dsh's `Default`); an omitted field
        // would instead leave the stored value in place.
        setCatalog(
          await modelCatalogApi.saveDefault({
            provider: activeSelection.provider,
            model: activeSelection.id,
            thinkingLevel: level,
            ...(cwd.length > 0 ? { cwd } : {}),
          }),
        );
      } catch (cause) {
        session.notify('warning', '推理等级未保存', errorText(cause));
      }
      return { type: 'response', command: 'set_thinking_level', success: true };
    },
    [activeSelection, cwd, refused, session, sessionId],
  );

  /**
   * The question the agent is waiting on, if any.
   *
   * pi blocks the extension on one dialog at a time, so the oldest is always the
   * actionable one; a later request stays in the session snapshot and surfaces
   * once this one resolves.
   */
  const pendingQuestion = session.dialogs[0] ?? null;

  /**
   * Send path for the composer: with a session attached it is a plain prompt,
   * otherwise the session is created first and the message goes straight to it
   * via `sendTo` — `session.prompt` would still close over the old (null) id
   * until the next render.
   */
  const guardedPrompt = useCallback<PiSessionApi['prompt']>(
    async (text, options) => {
      try {
        if (sessionId !== null) return await session.prompt(text, options);

        const created = await (pendingCreate.current ?? ensureSession());
        if ('error' in created) return failedPrompt(created.error);

        const body: PiCommandEnvelope = {
          type: 'prompt',
          message: text,
          ...(options?.images && options.images.length > 0 ? { images: options.images } : {}),
          ...(options?.behavior ? { streamingBehavior: options.behavior } : {}),
        };
        return await session.sendTo(created.id, body);
      } catch (cause) {
        return failedPrompt(errorText(cause));
      }
    },
    [ensureSession, session, sessionId],
  );

  /** The composer talks to the same api, with sending swapped for the lazy path
      and model/thinking writes routed through the paths that also record the
      deployment default. */
  const composerApi = useMemo<PiSessionApi>(
    () => ({
      ...session,
      prompt: guardedPrompt,
      setModel: applyModel,
      setThinkingLevel: applyThinkingLevel,
    }),
    [applyModel, applyThinkingLevel, guardedPrompt, session],
  );

  /** Apply a preset to the running session; the host records it on the session. */
  const applyToolPreset = useCallback(
    (preset: ToolPreset) => {
      if (sessionId === null) return;
      void session.setTools(toolNamesForPreset(preset));
    },
    [session, sessionId],
  );

  return { openSession, guardedPrompt, composerApi, applyModel, applyThinkingLevel, applyToolPreset, pendingQuestion };
}
