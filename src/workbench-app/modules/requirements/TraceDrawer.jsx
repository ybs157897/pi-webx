import { useEffect, useId, useRef, useState } from 'react'
import TraceContent, { deliveryAcceptanceBlockers } from './TraceContent.jsx'
import TraceDeliveryForm from './TraceDeliveryForm.jsx'
import { createTraceRequestScope } from './TraceRequestScope.js'
import './Trace.css'

const DRAFT_KEY = 'pi-webx-requirement-trace-draft'

function readDraft(requirementId) {
  if (typeof window === 'undefined') return null
  try { return JSON.parse(window.localStorage.getItem(`${DRAFT_KEY}:${requirementId}`) || 'null') } catch { return null }
}

function writeDraft(requirementId, draft) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(`${DRAFT_KEY}:${requirementId}`, JSON.stringify(draft)) } catch { /* optional */ }
}

function newEntryKey() {
  return globalThis.crypto?.randomUUID?.() ?? `requirement-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function requirementDeliveryPayload(trace, summary, evidence, runIds) {
  return { expectedRequirementVersion: trace.requirementVersion,
    expectedUpdatedAt: trace.requirement.updatedAt, summary, evidence,
    ...(runIds.length ? { runIds } : {}) }
}

export function requirementDeliveryFingerprint(trace, summary, evidence, runIds) {
  return JSON.stringify([trace.requirementVersion, summary, evidence, runIds])
}

async function postTrace(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(response.status === 409 ? '追踪状态已变化，请刷新后重新确认。'
      : typeof payload?.error === 'string' ? payload.error : '操作未确认，请检查追踪记录后重试。')
    error.status = response.status
    throw error
  }
  if (!payload?.trace) throw new Error('操作未确认，请检查追踪记录后重试。')
  return payload.trace
}

export function parseTraceLookup(input, fallback = 'auto') {
  const value = String(input ?? '').trim()
  if (fallback === 'auto' && /^id:/i.test(value)) return { id: value.slice(3).trim(), lookup: 'id', explicit: true }
  if (fallback === 'auto' && /^req:/i.test(value)) return { id: value.slice(4).trim(), lookup: 'human', explicit: true }
  return { id: value, lookup: fallback, explicit: false }
}

export async function readTrace(input, signal, fallback = 'auto') {
  const { id, lookup } = parseTraceLookup(input, fallback)
  if (!id) throw new Error('请输入需求 ID。')
  const response = await fetch(`/api/workbench/requirements/${encodeURIComponent(id)}/trace?lookup=${lookup}`, { signal })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(response.status === 404 ? '找不到这条需求的追踪记录。'
    : response.status === 409 ? '这个 ID 有歧义，请输入 id:原始ID 或 req:编号后重试。'
      : '追踪记录暂时无法加载，请重试。')
  if (!payload || (lookup === 'id' && payload.requirementId !== id)
    || (lookup === 'human' && payload.humanId !== id)
    || (lookup === 'auto' && payload.requirementId !== id && payload.humanId !== id)
    || !Array.isArray(payload.events)) throw new Error('追踪响应格式无效。')
  return payload
}

export default function TraceDrawer({ requirementId = '', onClose = () => {}, onChanged = () => {}, initialTrace = null }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const idInputRef = useRef(null)
  const [lookupId, setLookupId] = useState(requirementId)
  const [activeId, setActiveId] = useState(requirementId)
  const [lookupMode, setLookupMode] = useState(requirementId ? 'id' : 'auto')
  const [reload, setReload] = useState(0)
  const [trace, setTrace] = useState(initialTrace)
  const [loading, setLoading] = useState(!initialTrace && Boolean(requirementId))
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const [summary, setSummary] = useState('')
  const [evidence, setEvidence] = useState([{ kind: 'file', ref: '', label: '' }])
  const [runIdsText, setRunIdsText] = useState('')
  const [deliveryBusy, setDeliveryBusy] = useState(false)
  const [deliveryError, setDeliveryError] = useState('')
  const [reviewTarget, setReviewTarget] = useState(null)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [draftLoadedId, setDraftLoadedId] = useState(null)
  const pendingDeliveryRef = useRef(null)
  const pendingReviewsRef = useRef(new Map())
  const scopeRef = useRef(null)
  if (!scopeRef.current) scopeRef.current = createTraceRequestScope(requirementId)
  const scope = scopeRef.current
  const controlsBusy = deliveryBusy || reviewBusy

  useEffect(() => {
    scope.activate()
    return () => scope.deactivate()
  }, [])

  function draftSnapshot() {
    return { summary, evidence, runIdsText, reviewTarget, reviewComment,
      pendingDelivery: pendingDeliveryRef.current, pendingReviews: [...pendingReviewsRef.current] }
  }

  function persistDraft(draft) {
    if (!activeId) return
    writeDraft(activeId, draft)
    if (trace?.requirementId && trace.requirementId !== activeId) writeDraft(trace.requirementId, draft)
  }

  useEffect(() => {
    const saved = readDraft(activeId)
    setSummary(typeof saved?.summary === 'string' ? saved.summary.slice(0, 4000) : '')
    setEvidence(Array.isArray(saved?.evidence) && saved.evidence.length > 0
      ? saved.evidence.slice(0, 10).map(item => ({
        kind: ['file', 'commit', 'pull_request', 'test', 'report'].includes(item?.kind) ? item.kind : 'file',
        ref: typeof item?.ref === 'string' ? item.ref.slice(0, 1000) : '',
        label: typeof item?.label === 'string' ? item.label.slice(0, 200) : '',
      })) : [{ kind: 'file', ref: '', label: '' }])
    setRunIdsText(typeof saved?.runIdsText === 'string' ? saved.runIdsText : '')
    setReviewTarget(saved?.reviewTarget?.deliveryId ? saved.reviewTarget : null)
    setReviewComment(typeof saved?.reviewComment === 'string' ? saved.reviewComment : '')
    pendingDeliveryRef.current = saved?.pendingDelivery?.entryKey ? saved.pendingDelivery : null
    pendingReviewsRef.current = new Map(Array.isArray(saved?.pendingReviews)
      ? saved.pendingReviews.filter(item => Array.isArray(item) && typeof item[0] === 'string'
        && typeof item[1]?.entryKey === 'string') : [])
    setDraftLoadedId(activeId)
  }, [activeId])

  useEffect(() => {
    if (draftLoadedId === activeId) persistDraft(draftSnapshot())
  }, [activeId, draftLoadedId, trace?.requirementId, summary, evidence, runIdsText, reviewTarget, reviewComment, deliveryBusy, reviewBusy])

  useEffect(() => {
    if (initialTrace && activeId === requirementId && reload === 0) return undefined
    if (!activeId) { setTrace(null); setLoading(false); setError(''); return undefined }
    const token = scope.beginLookup(activeId)
    if (!token) return undefined
    const controller = new AbortController()
    const requestedId = activeId
    setLoading(true)
    setError('')
    void readTrace(activeId, controller.signal, lookupMode).then(result => {
      if (controller.signal.aborted || !scope.isCurrent(token)) return
      setTrace(result)
      const parsed = parseTraceLookup(requestedId, lookupMode)
      setLookupId(parsed.explicit ? `${parsed.lookup === 'human' ? 'req' : 'id'}:${parsed.lookup === 'human' ? result.humanId : result.requirementId}`
        : lookupMode === 'id' && /^(?:REQ-|id:|req:)/i.test(result.requirementId)
          ? `id:${result.requirementId}` : result.requirementId)
      setLoading(false)
    }).catch(cause => {
      if (controller.signal.aborted || !scope.isCurrent(token)) return
      setTrace(null)
      setError(cause instanceof Error ? cause.message : '追踪记录暂时无法加载，请重试。')
      setLoading(false)
    })
    return () => controller.abort()
  }, [activeId, requirementId, lookupMode, reload, initialTrace])

  useEffect(() => {
    if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return undefined
    const previousFocus = document.activeElement
    dialogRef.current?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  function submitLookup(event) {
    event.preventDefault()
    const next = lookupId.trim()
    if (!next) { setError('请输入需求 ID。'); return }
    if (!scope.switchTo(next)) return
    setTrace(null)
    setLoading(true)
    setError('')
    setLookupMode('auto')
    if (next === activeId) setReload(value => value + 1)
    else {
      persistDraft(draftSnapshot())
      setActiveId(next)
    }
  }

  async function copyId() {
    const value = trace?.requirementId || lookupId.trim()
    if (!value) return
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); setCopyStatus('已复制需求 ID'); return } catch { /* select for manual copy */ }
    }
    idInputRef.current?.select()
    setCopyStatus('已选中需求 ID，可手动复制')
  }

  function notifyChanged() {
    void Promise.resolve().then(() => scope.isActive() ? onChanged() : undefined).then(() => {
      if (scope.isActive()) setRefreshError('')
    }).catch(() => {
      if (scope.isActive()) setRefreshError('交付操作已保存，但需求列表暂未刷新。请重新打开需求记录查看最新状态，无需重提交付。')
    })
  }

  function changeEvidence(index, field, value) {
    setEvidence(current => current.map((item, at) => at === index ? { ...item, [field]: value } : item))
    setDeliveryError('')
  }

  function selectRun(runId) {
    if (!runId) return
    const ids = [...new Set([...runIdsText.split(',').map(id => id.trim()).filter(Boolean), runId])]
    setRunIdsText(ids.join(', '))
  }

  async function submitDelivery() {
    if (!trace || scope.isBusy()) return
    const cleanSummary = summary.trim()
    const cleanEvidence = evidence.filter(item => item.ref.trim()).map(item => ({
      kind: item.kind, ref: item.ref.trim(), ...(item.label.trim() ? { label: item.label.trim() } : {}),
    }))
    if (!cleanSummary) { setDeliveryError('请填写交付说明。'); return }
    if (cleanEvidence.length === 0) { setDeliveryError('至少填写一条真实证据引用。'); return }
    if (cleanEvidence.length !== evidence.length) { setDeliveryError('请补齐每条证据的引用，或移除空行。'); return }
    const runIds = [...new Set(runIdsText.split(',').map(id => id.trim()).filter(Boolean))]
    const draftFingerprint = requirementDeliveryFingerprint(trace, cleanSummary, cleanEvidence, runIds)
    const previous = pendingDeliveryRef.current
    const samePending = previous?.draftFingerprint === draftFingerprint && previous?.request
    const request = samePending ? previous.request
      : requirementDeliveryPayload(trace, cleanSummary, cleanEvidence, runIds)
    const entryKey = samePending ? previous.entryKey : newEntryKey()
    const token = scope.beginMutation(activeId)
    if (!token) return
    pendingDeliveryRef.current = { draftFingerprint, request, entryKey }
    persistDraft(draftSnapshot())
    setDeliveryBusy(true)
    setDeliveryError('')
    let refreshAfterConflict = false
    try {
      const nextTrace = await postTrace(`/api/workbench/requirements/${encodeURIComponent(trace.requirementId)}/deliveries`,
        { ...request, entryKey })
      if (!scope.isCurrent(token)) return
      setTrace(nextTrace)
      setSummary('')
      setEvidence([{ kind: 'file', ref: '', label: '' }])
      setRunIdsText('')
      pendingDeliveryRef.current = null
      persistDraft({ ...draftSnapshot(), summary: '', evidence: [{ kind: 'file', ref: '', label: '' }],
        runIdsText: '', pendingDelivery: null })
      notifyChanged()
    } catch (cause) {
      if (!scope.isCurrent(token)) return
      if (cause?.status === 409) {
        pendingDeliveryRef.current = null
        persistDraft(draftSnapshot())
        refreshAfterConflict = true
      }
      setDeliveryError(cause instanceof Error ? cause.message : '交付未确认，请重试。')
    } finally {
      const current = scope.isCurrent(token)
      scope.finishMutation(token)
      if (current) {
        setDeliveryBusy(false)
        if (refreshAfterConflict) setReload(value => value + 1)
      }
    }
  }

  function beginReview(delivery, decision) {
    setReviewTarget({ deliveryId: delivery.id, decision })
    setReviewComment('')
    setReviewError('')
  }

  async function confirmReview(delivery, decision) {
    if (!trace || scope.isBusy()) return
    if (decision === 'accept' && (!trace.acceptanceReady || deliveryAcceptanceBlockers(trace, delivery).length > 0)) {
      setReviewError('交付尚不满足接受条件，请先处理阻塞项。')
      return
    }
    const comment = reviewComment.trim()
    const operation = `${delivery.id}:${decision}`
    const draftFingerprint = JSON.stringify([decision, comment])
    const previous = pendingReviewsRef.current.get(operation)
    const samePending = previous?.draftFingerprint === draftFingerprint && previous?.request
    const request = samePending ? previous.request : { decision, expectedUpdatedAt: delivery.updatedAt,
      ...(comment ? { comment } : {}) }
    const entryKey = samePending ? previous.entryKey : newEntryKey()
    const token = scope.beginMutation(activeId)
    if (!token) return
    pendingReviewsRef.current.set(operation, { draftFingerprint, request, entryKey })
    persistDraft(draftSnapshot())
    setReviewBusy(true)
    setReviewError('')
    let refreshAfterConflict = false
    try {
      const nextTrace = await postTrace(
        `/api/workbench/requirements/${encodeURIComponent(trace.requirementId)}/deliveries/${encodeURIComponent(delivery.id)}/review`,
        { ...request, entryKey })
      if (!scope.isCurrent(token)) return
      setTrace(nextTrace)
      setReviewTarget(null)
      setReviewComment('')
      pendingReviewsRef.current.delete(operation)
      persistDraft({ ...draftSnapshot(), reviewTarget: null, reviewComment: '',
        pendingReviews: [...pendingReviewsRef.current] })
      notifyChanged()
    } catch (cause) {
      if (!scope.isCurrent(token)) return
      if (cause?.status === 409) {
        pendingReviewsRef.current.delete(operation)
        persistDraft({ ...draftSnapshot(), reviewTarget: null,
          pendingReviews: [...pendingReviewsRef.current] })
        setReviewTarget(null)
        refreshAfterConflict = true
      }
      setReviewError(cause instanceof Error ? cause.message : '审阅未确认，请重试。')
    } finally {
      const current = scope.isCurrent(token)
      scope.finishMutation(token)
      if (current) {
        setReviewBusy(false)
        if (refreshAfterConflict) setReload(value => value + 1)
      }
    }
  }

  function handleKeys(event) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key !== 'Tab' || typeof document === 'undefined') return
    const focusable = [...dialogRef.current.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0)
    if (focusable.length === 0) { event.preventDefault(); return }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (document.activeElement === dialogRef.current) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus()
    }
  }

  return <div className="modal-backdrop req-trace-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="req-trace-drawer" ref={dialogRef} role="dialog" aria-modal="true"
      aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeys} data-testid="req-trace-drawer">
      <header className="req-trace-head">
        <div><p>需求全生命周期</p><h2 id={titleId}>全链路追踪</h2></div>
        <button type="button" className="icon-btn" aria-label="关闭全链路追踪" onClick={onClose}
          data-testid="req-trace-close">×</button>
      </header>
      <form className="req-trace-lookup" onSubmit={submitLookup}>
        <label htmlFor={`${titleId}-id`}>唯一需求 ID</label>
        <div>
          <input id={`${titleId}-id`} ref={idInputRef} className="input" value={lookupId}
            onChange={event => setLookupId(event.target.value)} disabled={controlsBusy} data-testid="req-trace-id-input" />
          <button type="submit" className="btn btn-sm" disabled={controlsBusy} data-testid="req-trace-lookup">查看</button>
          <button type="button" className="btn btn-sm" onClick={() => { void copyId() }} data-testid="req-trace-copy">复制</button>
        </div>
        {copyStatus && <p role="status" data-testid="req-trace-copy-status">{copyStatus}</p>}
      </form>
      <div className="req-trace-scroll">
        {refreshError && <p className="req-trace-notice is-error" role="status" data-testid="req-trace-refresh-warning">{refreshError}</p>}
        {!activeId && !loading && <p className="req-trace-notice" data-testid="req-trace-await-id">输入需求 UUID 或 REQ 编号后查看保留的完整追踪记录。</p>}
        {loading && <p className="req-trace-notice" role="status" data-testid="req-trace-loading">正在读取追踪记录…</p>}
        {error && <div className="req-trace-notice is-error" role="alert" data-testid="req-trace-error">
          <span>{error}</span><button type="button" className="btn btn-sm" disabled={controlsBusy}
            onClick={() => { if (scope.switchTo(activeId)) setReload(value => value + 1) }}
            data-testid="req-trace-retry">重试</button>
        </div>}
        {!loading && trace && <>
          <TraceContent trace={trace} reviewTarget={reviewTarget} reviewComment={reviewComment}
            onReviewCommentChange={setReviewComment} onBeginReview={beginReview}
            onCancelReview={() => setReviewTarget(null)} onConfirmReview={confirmReview}
            reviewBusy={controlsBusy} reviewError={reviewError} />
          {trace.archived ? <p className="req-trace-notice" data-testid="req-trace-archived">已删除的需求仅可查看历史追踪，不能提交新交付。</p>
            : <TraceDeliveryForm trace={trace} summary={summary} evidence={evidence} runIdsText={runIdsText}
              busy={controlsBusy} error={deliveryError} onSummaryChange={setSummary}
              onEvidenceChange={changeEvidence} onAddEvidence={() => setEvidence(current => [...current, { kind: 'file', ref: '', label: '' }])}
              onRemoveEvidence={index => setEvidence(current => current.filter((_, at) => at !== index))}
              onRunIdsChange={setRunIdsText} onSelectRun={selectRun} onSubmit={submitDelivery} />}
        </>}
      </div>
    </section>
  </div>
}
