/**
 * The sub-agent section's three independent reads, in one hook.
 *
 * The definitions list, the model catalog and the per-session tool catalog are
 * three separate requests that fail separately: one blank page must not take the
 * other two with it, and each keeps its own loader so the section can re-issue
 * exactly the read that failed (the retry buttons in the view call these).
 *
 * The definitions list is also the write target — every POST/PATCH/DELETE
 * answers with the whole fresh list — so `setListed` is handed out too; the
 * editor hook replaces the list with each write's answer.
 */

import { useCallback, useEffect, useState } from 'react'
import type {
  AgentDefinitionsResponse,
  AgentToolsResponse,
} from '../../shared/agent-definitions'
import type { ModelCatalog } from '../../shared/model-catalog'
import { AgentDefinitionsApiError, agentDefinitionsApi } from '../../lib/agentDefinitions'
import { modelCatalogApi } from '../../lib/modelCatalog'

/** An independently-loadable read. */
export interface CatalogState<T> {
  value: T | null
  error: string | undefined
  loading: boolean
}

/** The state every catalog starts in: nothing read yet, nothing failed. */
export const EMPTY_CATALOG: CatalogState<never> = { value: null, error: undefined, loading: false }

/** The message a failure carries; a thrown non-Error stringifies. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The HTTP status behind a failed write (`0` = the request never arrived). */
export function statusOf(error: unknown): number {
  return error instanceof AgentDefinitionsApiError ? error.status : 0
}

/** The section's reads, their state and their loaders. */
export interface AgentCatalog {
  /** The last definitions read; `undefined` until the first one lands. */
  listed: AgentDefinitionsResponse | undefined
  /** Swap in a write's answer: every write returns the fresh list. */
  setListed: (response: AgentDefinitionsResponse) => void
  listLoading: boolean
  listError: string | undefined
  /** Re-read the list; resolves to the fresh list, or `undefined` if it failed. */
  loadDefinitions: () => Promise<AgentDefinitionsResponse | undefined>
  models: CatalogState<ModelCatalog>
  loadModels: () => Promise<void>
  tools: CatalogState<AgentToolsResponse>
  loadTools: () => Promise<void>
}

/**
 * Read the definitions list and both catalogs once, at mount.
 * @param sessionId - scopes the tool catalog to that session when known.
 * @returns the three reads with their state and loaders.
 */
export function useAgentCatalog(sessionId?: string): AgentCatalog {
  const [listed, setListed] = useState<AgentDefinitionsResponse | undefined>(undefined)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | undefined>(undefined)

  const [models, setModels] = useState<CatalogState<ModelCatalog>>(EMPTY_CATALOG)
  const [tools, setTools] = useState<CatalogState<AgentToolsResponse>>(EMPTY_CATALOG)

  const loadDefinitions = useCallback(async (): Promise<AgentDefinitionsResponse | undefined> => {
    setListLoading(true)
    try {
      const answer = await agentDefinitionsApi.read()
      setListed(answer)
      setListError(undefined)
      return answer
    } catch (error) {
      setListError(messageOf(error))
      return undefined
    } finally {
      setListLoading(false)
    }
  }, [])

  const loadModels = useCallback(async (): Promise<void> => {
    setModels({ value: null, error: undefined, loading: true })
    try {
      const value = await modelCatalogApi.read()
      setModels({ value, error: undefined, loading: false })
    } catch (error) {
      setModels({ value: null, error: messageOf(error), loading: false })
    }
  }, [])

  const loadTools = useCallback(async (): Promise<void> => {
    setTools({ value: null, error: undefined, loading: true })
    try {
      const value = await agentDefinitionsApi.tools(sessionId)
      setTools({ value, error: undefined, loading: false })
    } catch (error) {
      setTools({ value: null, error: messageOf(error), loading: false })
    }
  }, [sessionId])

  /* Three independent reads; a failure in one must not blank the other two. */
  useEffect(() => {
    void loadDefinitions()
    void loadModels()
    void loadTools()
  }, [loadDefinitions, loadModels, loadTools])

  return {
    listed,
    setListed,
    listLoading,
    listError,
    loadDefinitions,
    models,
    loadModels,
    tools,
    loadTools,
  }
}
