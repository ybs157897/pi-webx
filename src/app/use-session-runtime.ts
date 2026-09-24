/**
 * 会话运行时：bridge 的三份列表加载（会话、磁盘转写、模型目录）、地址栏里那个
 * 「服务端已经不认」的会话的自动恢复，以及模型选择/工具预设的派生。
 *
 * 加载函数在这里定义而不是在各自的 hook 里：地址栏恢复路径与用户动作共用它们。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { api as bridge } from '../lib/api';
import { catalogDefaultSelection, modelCatalogApi } from '../lib/modelCatalog';
import type { PiSessionApi } from '../lib/usePiSession';
import type { ModelSelection } from '../components/ModelPicker';
import { presetFromToolNames, type ToolPreset } from '../shared/tool-presets';
import type { ShellState } from './use-shell-state';

export type SessionRuntime = ReturnType<typeof useSessionRuntime>;

export function useSessionRuntime(state: ShellState, session: PiSessionApi) {
  const {
    sessionId, sessions, sessionsLoaded, newSessionMode,
    pendingModel, catalog,
    setCwd, setSessions, setSessionsLoaded, setAllStored, setCatalog,
  } = state;

  /** Set once a resume has been attempted for an id, so the poll cannot loop. */
  const resumeAttempted = useRef<string | null>(null);

  /**
   * The model a new session starts from: the user's in-flight pick, else the
   * deployment default read from pi's own settings. This replaces an earlier
   * read of a localStorage slot nothing ever wrote — which is why every new
   * session silently fell back to whatever settings.json happened to hold.
   */
  const defaultModel: ModelSelection | null = useMemo(
    () => pendingModel ?? catalogDefaultSelection(catalog),
    [pendingModel, catalog],
  );

  /**
   * The preset the active session is running with, read back from its own record —
   * a resumed transcript reports the tools it was last run with, so the control
   * shows that rather than the browser preference.
   */
  const sessionToolPreset: ToolPreset | null = useMemo(
    () => (session.toolSelection === null ? null : presetFromToolNames(session.toolSelection)),
    [session.toolSelection],
  );

  /** The running session's model when there is one, else the pending default. */
  const activeSelection: ModelSelection | null = useMemo(() => {
    const live = session.piState?.model;
    return live ? { provider: live.provider, id: live.id } : defaultModel;
  }, [defaultModel, session.piState?.model]);

  const loadCatalog = useCallback(async (target: string): Promise<void> => {
    try {
      setCatalog(await modelCatalogApi.read(target.length > 0 ? target : undefined));
    } catch {
      // Transient: the picker falls back to the session's own catalogue, and
      // the next load retries. A missing catalog must not block sending.
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions((await bridge.listSessions()).sessions);
      // The list has been read at least once, so "not in it" now means the
      // bridge does not have this session — see the resume effect below.
      setSessionsLoaded(true);
    } catch {
      // transient; the poll retries
    }
  }, []);

  const loadStored = useCallback(async () => {
    try {
      // One unfiltered listing covers both the sidebar list and the per-workspace counts.
      // Cheap to repeat: the bridge caches each transcript's header and preview
      // and only re-reads a file whose size/mtime moved, so this is a stat pass
      // in the steady state rather than a body scan.
      setAllStored((await bridge.storedSessions({ limit: 100 })).sessions);
    } catch {
      setAllStored([]);
    }
  }, []);

  /**
   * 「地址里有 id，但服务端已经不认这个会话」时自动把它捞回来。
   *
   * 桥接服务重启会结束所有内存中的会话，而页面地址栏里只有 `?session=<id>`。
   * 以前这种情况下正文直接空掉、提示去会话列表手动重新打开；其实转写就在磁盘上，
   * `POST /api/sessions { sessionId }` 自己会去找文件（见 `findStoredSessionById`）。
   * 这里只负责在确认这个会话确实不在内存里之后发一次请求。
   *
   * 只在「桥接的会话列表已经读到、且里面没有这个 id」时动手：连接未建立或列表还没
   * 读到的空列表不代表会话不在，那样会在启动瞬间白捞一次。判定刻意**不**看会话
   * 客户端的状态——一个服务端已经不认的会话永远等不到 live，用它当门槛恰好会在最
   * 需要这条路径的时候不触发。每个 id 只试一次，避免和轮询互相触发成环。
   */
  useEffect(() => {
    if (sessionId === null || !sessionsLoaded) return;
    if (sessions.some((entry) => entry.id === sessionId)) return;
    if (resumeAttempted.current === sessionId) return;
    resumeAttempted.current = sessionId;
    void (async () => {
      try {
        const result = await bridge.createSession({
          sessionId,
          ...(newSessionMode === 'team' ? { teamMode: true } : {}),
        });
        setCwd(result.session.cwd);
        await refreshSessions();
      } catch {
        // 磁盘上也没有这个 id：保留现场提示，不打扰用户。
      }
    })();
  }, [newSessionMode, refreshSessions, sessions, sessionId, sessionsLoaded]);

  return { defaultModel, sessionToolPreset, activeSelection, loadCatalog, refreshSessions, loadStored };
}
