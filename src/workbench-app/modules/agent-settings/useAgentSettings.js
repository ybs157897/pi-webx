import { useCallback, useEffect, useRef, useState } from 'react'
import { modelCatalogApi } from '../../../lib/modelCatalog'
import { agentSettingsApi, AgentSettingsApiError } from './api'
import { copyDraft, isDirty, updateBody, validateDraft } from './draft'

export function useAgentSettings(id) {
  const [view, setView] = useState(null)
  const [draft, setDraft] = useState(null)
  const [requestedId, setRequestedId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [showValidation, setShowValidation] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState('')
  const generation = useRef(0)
  const savingRef = useRef(null)
  const isSaving = useCallback(() => savingRef.current !== null, [])

  const reload = useCallback(async () => {
    if (savingRef.current !== null) return
    const request = ++generation.current
    setRequestedId(id)
    setView(null)
    setDraft(null)
    setLoading(true)
    setFeedback(null)
    setShowValidation(false)
    try {
      const next = await agentSettingsApi.read(id)
      if (generation.current !== request) return
      setView(next)
      setDraft(copyDraft(next))
    } catch (error) {
      if (generation.current !== request) return
      setFeedback({ tone: 'error', message: error.message || '配置读取失败。' })
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [id])

  useEffect(() => {
    reload()
    return () => { generation.current += 1 }
  }, [reload])

  useEffect(() => {
    let active = true
    setCatalogError('')
    modelCatalogApi.read().then(
      result => { if (active) setCatalog(result) },
      error => { if (active) setCatalogError(error.message || '模型目录暂不可用。') },
    )
    return () => { active = false }
  }, [])

  const edit = useCallback(updater => {
    setDraft(current => current === null ? current : updater(current))
    setFeedback(null)
  }, [])

  const save = useCallback(async () => {
    if (savingRef.current !== null || !view || !draft || view.id !== id) return
    const nextErrors = validateDraft(draft)
    if (Object.keys(nextErrors).length > 0) {
      setShowValidation(true)
      setFeedback({ tone: 'error', message: '请先修正标出的字段，再保存。' })
      return
    }
    const request = generation.current
    savingRef.current = request
    setSaving(true)
    setFeedback(null)
    try {
      const next = await agentSettingsApi.save(id, updateBody(view, draft))
      if (generation.current !== request) return
      setView(next)
      setDraft(copyDraft(next))
      setShowValidation(false)
      setFeedback({ tone: 'ok', message: '已保存。新对话将使用最新配置。' })
    } catch (error) {
      if (generation.current !== request) return
      const conflict = error instanceof AgentSettingsApiError && error.status === 409
      setFeedback({
        tone: 'error',
        conflict,
        message: conflict
          ? '配置已在别处更新（409）。你的草稿仍在；可复制内容后重新读取服务端配置。'
          : error.message || '保存失败，草稿已保留。',
      })
    } finally {
      if (savingRef.current === request) savingRef.current = null
      if (generation.current === request) setSaving(false)
    }
  }, [view, draft, id])

  return {
    view: view?.id === id ? view : null,
    draft: view?.id === id ? draft : null,
    loading: loading || requestedId !== id || (view?.id !== id && feedback === null),
    saving, feedback: requestedId === id ? feedback : null,
    errors: showValidation && draft ? validateDraft(draft) : {}, catalog, catalogError,
    dirty: view?.id === id && isDirty(view, draft),
    edit, save, reload, isSaving,
  }
}
