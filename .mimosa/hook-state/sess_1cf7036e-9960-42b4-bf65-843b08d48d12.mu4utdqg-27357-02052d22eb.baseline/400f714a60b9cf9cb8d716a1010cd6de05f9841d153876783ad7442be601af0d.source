/**
 * Typed client for the local pi bridge. Every endpoint is same-origin `/api`,
 * proxied to the bridge process by Vite in dev and served directly in production.
 */

import type {
  CommandResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  FsListResponse,
  ListSessionsResponse,
  ListStoredSessionsResponse,
  PiCommandEnvelope,
  PiRpcResponse,
  ServerConfigResponse,
  SessionSummary,
} from '../shared/protocol';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    throw new ApiError(0, `cannot reach the pi bridge: ${errorText(error)}`);
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const message =
      isRecord(payload) && typeof payload['error'] === 'string'
        ? payload['error']
        : `request failed (${res.status} ${res.statusText})`;
    throw new ApiError(res.status, message);
  }

  return payload as T;
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const api = {
  config(): Promise<ServerConfigResponse> {
    return request<ServerConfigResponse>('/api/config');
  },

  listSessions(): Promise<ListSessionsResponse> {
    return request<ListSessionsResponse>('/api/sessions');
  },

  createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
    return request<CreateSessionResponse>('/api/sessions', jsonInit(body));
  },

  deleteSession(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  sendCommand(id: string, command: PiCommandEnvelope): Promise<PiRpcResponse> {
    const body = { command } satisfies { command: PiCommandEnvelope };
    return request<CommandResponse>(
      `/api/sessions/${encodeURIComponent(id)}/command`,
      jsonInit(body),
    ).then((payload) => payload.response);
  },

  fsList(path: string): Promise<FsListResponse> {
    return request<FsListResponse>(`/api/fs/list?path=${encodeURIComponent(path)}`);
  },

  storedSessions(options?: { cwd?: string; limit?: number }): Promise<ListStoredSessionsResponse> {
    const params = new URLSearchParams();
    if (options?.cwd) params.set('cwd', options.cwd);
    if (options?.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return request<ListStoredSessionsResponse>(
      `/api/stored-sessions${query.length > 0 ? `?${query}` : ''}`,
    );
  },

  /** Permanently removes one persisted pi transcript from disk. */
  deleteStoredSession(path: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/stored-sessions?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    );
  },
};

export function isSessionSummary(value: unknown): value is SessionSummary {
  return isRecord(value) && typeof value['id'] === 'string';
}
