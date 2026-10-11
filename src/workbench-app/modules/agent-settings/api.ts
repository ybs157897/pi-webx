import type { AgentSettingsUpdate, AgentSettingsView, ModuleAgentSettingsId } from '../../../shared/module-agent-settings';

export class AgentSettingsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AgentSettingsApiError';
    this.status = status;
  }
}

async function request(id: ModuleAgentSettingsId, init?: RequestInit): Promise<AgentSettingsView> {
  let response: Response;
  try {
    response = await fetch(`/api/module-agents/${id}/settings`, init);
  } catch {
    throw new AgentSettingsApiError(0, '无法连接本机服务，请检查服务状态后重试。');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AgentSettingsApiError(response.status, '服务返回了无法读取的配置响应。');
  }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `配置请求失败（HTTP ${response.status}）。`;
    throw new AgentSettingsApiError(response.status, message);
  }
  return payload as AgentSettingsView;
}

export const agentSettingsApi = {
  read(id: ModuleAgentSettingsId): Promise<AgentSettingsView> {
    return request(id);
  },
  save(id: ModuleAgentSettingsId, update: AgentSettingsUpdate): Promise<AgentSettingsView> {
    return request(id, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    });
  },
  reset(id: ModuleAgentSettingsId): Promise<AgentSettingsView> {
    return request(id, { method: 'DELETE' });
  },
  async polish(id: ModuleAgentSettingsId, prompt: string, model: AgentSettingsView['model'], signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`/api/module-agents/${id}/settings/polish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, model }), signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AgentSettingsApiError(0, '无法连接本机服务，请稍后重试。');
    }
    let payload: { prompt?: unknown; error?: unknown };
    try { payload = await response.json(); }
    catch { throw new AgentSettingsApiError(response.status, '服务返回了无法读取的润色结果。'); }
    if (!response.ok) throw new AgentSettingsApiError(response.status,
      typeof payload.error === 'string' ? payload.error : `润色失败（HTTP ${response.status}）。`);
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim())
      throw new AgentSettingsApiError(response.status, '服务未返回有效的润色结果。');
    return payload.prompt;
  },
};
