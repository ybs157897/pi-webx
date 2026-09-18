/**
 * Typed client for the provider list and credential editing.
 *
 * Mirrors deepseek-harness's split between reading providers (a plain read that
 * needs no session) and writing credentials (which goes through the provider's
 * own login flow on the bridge). Errors are the bridge's already user-readable
 * Chinese text, passed through verbatim.
 */

import type { CredentialWriteResponse, ListProvidersResponse } from '../shared/providers';

export class ProvidersApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProvidersApiError';
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
    throw new ProvidersApiError(0, `无法连接 pi 服务：${errorText(error)}`);
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
        : `请求失败（${res.status} ${res.statusText}）`;
    throw new ProvidersApiError(res.status, message);
  }

  return payload as T;
}

export const providersApi = {
  list(): Promise<ListProvidersResponse> {
    return request<ListProvidersResponse>('/api/providers');
  },

  /** Store a key through the provider's own flow; answers with the fresh list. */
  setCredential(id: string, apiKey: string): Promise<CredentialWriteResponse> {
    return request<CredentialWriteResponse>(
      `/api/providers/${encodeURIComponent(id)}/credential`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      },
    );
  },

  removeCredential(id: string): Promise<CredentialWriteResponse> {
    return request<CredentialWriteResponse>(
      `/api/providers/${encodeURIComponent(id)}/credential`,
      { method: 'DELETE' },
    );
  },
};
