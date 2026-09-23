import { useEffect, useState } from 'react'
import { Modal } from '../ui.jsx'

export function PiDialog({ request, onRespond }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValue(request?.prefill ?? request?.options?.[0] ?? '')
    setBusy(false)
  }, [request?.id])

  if (!request) return null

  async function answer(body) {
    setBusy(true)
    try {
      await onRespond(request.id, body)
    } finally {
      setBusy(false)
    }
  }

  const isConfirm = request.method === 'confirm'
  const needsValue = request.method === 'select' || request.method === 'input' || request.method === 'editor'
  return (
    <Modal
      open
      title={request.title || 'Pi Agent 提问'}
      onClose={() => { if (!busy) void answer({ cancelled: true }) }}
      footer={<>
        <button type="button" className="btn" disabled={busy} onClick={() => void answer(isConfirm ? { confirmed: false } : { cancelled: true })}>取消</button>
        <button type="button" className="btn btn-primary" disabled={busy || (needsValue && value.trim() === '')} onClick={() => void answer(isConfirm ? { confirmed: true } : { value })}>{busy ? '发送中…' : isConfirm ? '确认' : '提交'}</button>
      </>}
    >
      {request.message && <p className="small" style={{ marginBottom: '12px' }}>{request.message}</p>}
      {request.method === 'select' && <select className="input" aria-label="选择答案" value={value} onChange={(event) => setValue(event.target.value)}>{(request.options ?? []).map((option) => <option key={option}>{option}</option>)}</select>}
      {request.method === 'input' && <input className="input" autoFocus aria-label="输入答案" placeholder={request.placeholder ?? ''} value={value} onChange={(event) => setValue(event.target.value)} />}
      {request.method === 'editor' && <textarea className="textarea" autoFocus aria-label="编辑答案" rows={6} value={value} onChange={(event) => setValue(event.target.value)} />}
    </Modal>
  )
}
