/**
 * Typed client for the user-owned sub-agent definitions surface.
 *
 * The server owns the file and its revision; this client only speaks the frozen
 * wire contract in `src/shared/agent-definitions.ts`. Two rules shape it:
 *
 *   - **Writes are compare-and-set.** Every POST/PATCH/DELETE carries the
 *     `expectedRevision` the caller last saw, and the server answers a stale one
 *     with 409 rather than merging. The client therefore never retries a write on
 *     its own — a lost update is the user's decision to make, not the transport's.
 *   - **Failures carry the server's message, never a stack.** The bridge answers
 *     errors as `{ error: string }`; this client surfaces exactly that string on
 *     {@link AgentDefinitionsApiError} and keeps the status for the callers that
 *     branch on 404/409.
 *
 * Self-contained on purpose: the repo's other clients keep their `request`
 * helper private, and a shared transport module is not worth inventing for the
 * fourth copy of twenty lines.
 */

import type {
  AgentDefinitionInput,
  AgentDefinitionPatch,
  AgentDefinitionsResponse,
  AgentToolsResponse,
  CreateAgentDefinitionRequest,
  DeleteAgentDefinitionRequest,
  UpdateAgentDefinitionRequest,
} from '../shared/agent-definitions';

/** A failed definitions call: the HTTP status (0 = never reached the server). */
export class AgentDefinitionsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AgentDefinitionsApiError';
    this.status = status;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    throw new AgentDefinitionsApiError(0, `无法连接 pi 服务：${errorText(error)}`);
  }

  const answer = await res.text();
  let payload: unknown = null;
  if (answer.length > 0) {
    try {
      payload = JSON.parse(answer);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    // Only the server's own `error` string is surfaced. A malformed body must
    // not leak a raw payload or a thrown parser error into the UI.
    const message =
      isRecord(payload) && typeof payload['error'] === 'string'
        ? payload['error']
        : `请求失败（${res.status} ${res.statusText}）`;
    throw new AgentDefinitionsApiError(res.status, message);
  }

  return payload as T;
}

/** JSON body init; every write on this surface is a JSON POST/PATCH/DELETE. */
function jsonInit(method: 'POST' | 'PATCH' | 'DELETE', body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function agentPath(id: string): string {
  return `/api/agent-definitions/${encodeURIComponent(id)}`;
}

export const agentDefinitionsApi = {
  /** Read the whole definitions file. */
  read(): Promise<AgentDefinitionsResponse> {
    return request<AgentDefinitionsResponse>('/api/agent-definitions');
  },

  /**
   * Append one definition.
   * @param expectedRevision - file revision the caller read last.
   * @param definition - the user-editable half.
   */
  create(
    expectedRevision: number,
    definition: AgentDefinitionInput,
  ): Promise<AgentDefinitionsResponse> {
    const body: CreateAgentDefinitionRequest = { expectedRevision, definition };
    return request<AgentDefinitionsResponse>('/api/agent-definitions', jsonInit('POST', body));
  },

  /**
   * Patch one definition. An empty patch is a legal read-back.
   * @param id - server-assigned definition id.
   * @param expectedRevision - file revision the caller read last.
   * @param patch - fields to replace; omitted fields keep their stored value. A
   *   `thinkingLevel: null` clears the stored level (back to inheriting the
   *   parent's) — the one field where "omitted" and "cleared" must differ, since
   *   JSON has no `undefined` to mean both.
   */
  update(
    id: string,
    expectedRevision: number,
    patch: AgentDefinitionPatch,
  ): Promise<AgentDefinitionsResponse> {
    const body: UpdateAgentDefinitionRequest = { expectedRevision, patch };
    return request<AgentDefinitionsResponse>(agentPath(id), jsonInit('PATCH', body));
  },

  /** Delete one definition. */
  delete(id: string, expectedRevision: number): Promise<AgentDefinitionsResponse> {
    const body: DeleteAgentDefinitionRequest = { expectedRevision };
    return request<AgentDefinitionsResponse>(agentPath(id), jsonInit('DELETE', body));
  },

  /**
   * The tool catalog offered in `selected` mode.
   * @param sessionId - when known, extension tools are scoped to that session;
   *   omitted, the catalog is built-ins only and the form says so.
   */
  tools(sessionId?: string): Promise<AgentToolsResponse> {
    const query =
      sessionId !== undefined && sessionId.length > 0
        ? `?sessionId=${encodeURIComponent(sessionId)}`
        : '';
    return request<AgentToolsResponse>(`/api/agent-definitions/tools${query}`);
  },
};
