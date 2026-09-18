/**
 * Client for the bridge's model-discovery endpoint (`POST
 * /api/models-config/discover`): asks the endpoint the form currently shows —
 * including a key typed but not yet saved — for the models it serves. The
 * reply is candidate ids the user picks from, never configuration written
 * behind them.
 */

import { errorMessage } from '../../lib/modelsConfig'

/** What an interrogation needs, taken from the live form. */
export interface DiscoverTarget {
  /** Route being edited; the server falls back to its stored baseUrl/key. */
  providerId?: string
  /** Endpoint as the form currently shows it. */
  baseUrl?: string
  /** Key typed into the form and not yet stored, when there is one. */
  apiKey?: string
}

/**
 * Fetch the candidate model ids one endpoint serves.
 * @param target - the live form facts.
 * @returns the sorted, deduped ids.
 * @throws Error with the bridge's Chinese failure text (no key material ever
 * appears in it).
 */
export async function discoverModels(target: DiscoverTarget): Promise<string[]> {
  let res: Response
  try {
    res = await fetch('/api/models-config/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...target.baseUrl === undefined ? {} : { baseUrl: target.baseUrl },
        ...target.providerId === undefined ? {} : { providerId: target.providerId },
        ...target.apiKey === undefined ? {} : { apiKey: { value: target.apiKey } },
      }),
    })
  } catch (error) {
    throw new Error(`无法连接 pi 服务：${errorMessage(error)}`)
  }
  const text = await res.text()
  let payload: unknown = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  if (!res.ok) {
    const message = typeof payload === 'object' && payload !== null
      && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `拉取模型列表失败（${res.status} ${res.statusText}）`
    throw new Error(message)
  }
  const models = typeof payload === 'object' && payload !== null
    ? (payload as { models?: unknown }).models
    : undefined
  if (!Array.isArray(models)) throw new Error('拉取模型列表失败：响应格式无法识别')
  return models.filter((id): id is string => typeof id === 'string' && id.length > 0)
}
