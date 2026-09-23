import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api } from './api';
import type { TeamProjection } from '../shared/agent-team';

interface TeamSnapshotState {
  readonly sessionId: string | null;
  readonly snapshot: TeamProjection | null;
  readonly loading: boolean;
  readonly ready: boolean;
  readonly error: string | null;
}

const EMPTY: TeamSnapshotState = { sessionId: null, snapshot: null, loading: false, ready: false, error: null };

/** Team state has no WS subscription. Poll only while its panel is visible. */
export function useTeamSnapshot(sessionId: string | null, panelOpen: boolean) {
  const [state, setState] = useState<TeamSnapshotState>(() => (
    sessionId === null ? EMPTY : { sessionId, snapshot: null, loading: true, ready: false, error: null }
  ));
  const generation = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionId === null) return;
    const request = ++generation.current;
    try {
      const snapshot = await api.team(sessionId);
      if (generation.current === request) {
        setState({ sessionId, snapshot, loading: false, ready: true, error: null });
      }
    } catch (cause) {
      if (generation.current !== request) return;
      if (cause instanceof ApiError && cause.status === 404) {
        setState({ sessionId, snapshot: null, loading: false, ready: true, error: null });
      } else {
        setState((current) => ({
          ...current,
          sessionId,
          loading: false,
          ready: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    }
  }, [sessionId]);

  useEffect(() => {
    generation.current += 1;
    setState(sessionId === null ? EMPTY : { sessionId, snapshot: null, loading: true, ready: false, error: null });
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh, sessionId]);

  useEffect(() => {
    if (!panelOpen || sessionId === null) return;
    const interval = window.setInterval(() => { void refresh(); }, 2500);
    return () => { window.clearInterval(interval); };
  }, [panelOpen, refresh, sessionId]);

  return { ...state, refresh };
}
