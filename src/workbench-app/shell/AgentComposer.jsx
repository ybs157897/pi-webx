import { useEffect, useRef, useState } from 'react'
import { ComposerAttachments } from '../../components/ComposerAttachments'
import { IMAGE_TYPES } from '../../shared/attachments'
import { TEXT_ATTACHMENT_EXTENSIONS, attachmentAdmissionError, attachmentBadge, fileToImage, readTextAttachment } from './composer-attachments.mjs'

const TEXT = {
  send: '发送',
  sendPlaceholder: '和小台说点什么…（Enter 发送，Shift+Enter 换行）',
}

const attachmentId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `attach-${Date.now()}-${Math.random()}`)

/**
 * 输入框：Enter 发送、Shift+Enter 换行，高度随内容自增到上限。
 * `supportsImages` 打开时多一个回形针入口：图片走 PiImage 内联管线（与 /chat 同款），
 * 文本文件在读出发送时内联进消息；准入错误钉在输入框上方，4 秒自动消失。
 */
export default function AgentComposer({ busy, sendDisabled, running, onSend, onStop, stopping, onSteerQueued, draft, onDraftChange, placeholder, leading, visible, supportsImages }) {
  const [localValue, setLocalValue] = useState('')
  const value = draft ?? localValue
  const setValue = onDraftChange ?? setLocalValue
  const inputRef = useRef(null)
  const latest = useRef(value)
  latest.current = value
  // 附件两份列表（与 /chat 的 Composer 同形）：images 带 object URL 预览，files 只是待读的文本文件。
  // ref 镜像给事件处理函数读最新值；卸载时 revoke 全部预览 URL。
  const [images, setImages] = useState([])
  const [files, setFiles] = useState([])
  const imagesRef = useRef([])
  const filesRef = useRef([])
  const fileInputRef = useRef(null)
  const [notice, setNotice] = useState(null)
  const noticeTimer = useRef(null)
  // 拖拽悬浮层：dragenter/leave 用计数器配对，子元素间来回穿梭不会闪烁。
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const blocked = (sendDisabled ?? busy) || submitting || stopping
  const hasContent = value.trim() !== '' || images.length > 0 || files.length > 0
  const supportsSteer = typeof onSteerQueued === 'function'

  useEffect(() => {
    const node = inputRef.current
    if (!node || !visible) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(132, node.scrollHeight)}px`
  }, [value, visible])

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl)
  }, [])

  /** 换掉图片列表并 revoke 掉被移除项的预览 URL（/chat 的 replaceImages 同款）。 */
  function replaceImages(next) {
    const keep = new Set(next.map(image => image.id))
    for (const image of imagesRef.current) if (!keep.has(image.id)) URL.revokeObjectURL(image.previewUrl)
    imagesRef.current = next
    setImages(next)
  }
  function replaceFiles(next) {
    filesRef.current = next
    setFiles(next)
  }
  /** 准入失败的人话提示：4 秒后自动清掉（/chat 的 flash 同款）。 */
  function flash(message) {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 4_000)
  }

  /** 拖拽落点与回形针/粘贴共用 addFiles（准入、分桶都在里面）。 */
  function onDragEnter(event) {
    if (!supportsImages || blocked) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  function onDragOver(event) {
    if (!supportsImages || blocked) return
    event.preventDefault()
  }
  function onDragLeave(event) {
    if (!supportsImages) return
    event.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragging(false)
    }
  }
  function onDrop(event) {
    if (!supportsImages) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    addFiles(event.dataTransfer?.files)
  }
  /** 选文件与粘贴共用的入口：先过准入，再按图片 / 文本分桶挂上。 */
  function addFiles(batch) {
    const list = Array.from(batch ?? [])
    if (!supportsImages || blocked || list.length === 0) return
    const error = attachmentAdmissionError(list, imagesRef.current.map(image => image.file), filesRef.current.length)
    if (error) { flash(error); return }
    const picked = list.filter(file => IMAGE_TYPES.some(type => type === file.type))
    const texts = list.filter(file => !IMAGE_TYPES.some(type => type === file.type))
    replaceImages([...imagesRef.current, ...picked.map(file => ({ id: attachmentId(), file, previewUrl: URL.createObjectURL(file) }))])
    replaceFiles([...filesRef.current, ...texts.map(file => ({ id: attachmentId(), file }))])
  }

  async function submit(steer = false) {
    const original = value
    const text = value.trim()
    if (blocked || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      if (!hasContent) {
        if (steer && running && supportsSteer) await onSteerQueued()
        return
      }
      const sentImages = imagesRef.current
      const sentFiles = filesRef.current
      const attachments = {
        images: await Promise.all(sentImages.map(image => fileToImage(image.file))),
        files: await Promise.all(sentFiles.map(file => readTextAttachment(file.file))),
      }
      const accepted = await onSend(text, attachments, steer && supportsSteer ? { behavior: 'steer' } : {})
      if (accepted !== false) {
        replaceImages(imagesRef.current.filter(image => !sentImages.some(sent => sent.id === image.id)))
        replaceFiles(filesRef.current.filter(file => !sentFiles.some(sent => sent.id === file.id)))
        if (latest.current === original) {
          if (onDraftChange) onDraftChange('', original)
          else setLocalValue('')
        }
      }
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  // 整个输入区都是拖拽落点：包一层 drop-zone，悬浮层与文件卡片都挂在里面。
  return (
    <div className="composer-drop" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {dragging && <div className="attach-drag-overlay" data-testid="module-attach-dragging">放开以添加图片或文件</div>}
      {notice !== null && <p role="alert" className="attach-error" data-testid="module-attach-error">⚠️ {notice}</p>}
      {images.length > 0 && (
        <div className="composer-attachments" data-testid="module-attachments">
          <ComposerAttachments images={images} disabled={blocked} onRemove={id => replaceImages(imagesRef.current.filter(image => image.id !== id))} />
        </div>
      )}
      {files.length > 0 && (
        <div className="attach-files">
          {files.map(file => {
            const badge = attachmentBadge(file.file)
            return (
              <span className="attach-file" data-testid="module-attach-file" key={file.id}>
                <span className={`attach-file-icon tone-${badge.tone}`} aria-hidden="true">{badge.glyph}</span>
                <span className="attach-file-meta">
                  <span className="attach-file-name">{file.file.name}</span>
                  <span className="attach-file-type">{badge.label}</span>
                </span>
                <button type="button" aria-label={`移除附件 ${file.file.name}`} disabled={blocked} onClick={() => replaceFiles(filesRef.current.filter(item => item.id !== file.id))}>×</button>
              </span>
            )
          })}
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          data-testid="module-agent-input"
          value={value}
          placeholder={placeholder ?? TEXT.sendPlaceholder}
          aria-label={placeholder ?? TEXT.sendPlaceholder}
          onChange={event => setValue(event.target.value)}
          onPaste={event => {
            // 只收剪贴板里的图片；纯文本粘贴不拦截，走浏览器默认行为。
            const pastedFiles = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
            if (pastedFiles.length === 0) return
            event.preventDefault()
            addFiles(pastedFiles)
            const pasted = event.clipboardData.getData('text/plain')
            if (pasted !== '') {
              const area = event.currentTarget
              setValue(value.slice(0, area.selectionStart) + pasted + value.slice(area.selectionEnd))
            }
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault()
              void submit(event.metaKey || event.ctrlKey)
            }
          }}
        />
        {supportsImages && <button type="button" className="module-attach" data-testid="module-attach" aria-label="添加图片或附件" title="添加图片或附件" disabled={blocked} onClick={() => fileInputRef.current?.click()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
          </svg>
        </button>}
        {leading}
        <div className="module-composer-buttons" data-testid="module-agent-controls">
        {onStop ? <button type="button" className="send-btn" data-testid="module-agent-stop" aria-label="停止当前回答" title="停止当前回答" disabled={stopping} onClick={onStop}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
        </button> : null}
        <button type="button" className="send-btn" data-testid="module-agent-send" aria-label={running && supportsSteer ? '排队发送' : TEXT.send} title={running && supportsSteer ? '排队发送（Enter）' : TEXT.send} disabled={blocked || !hasContent} onClick={() => { void submit() }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 4.4 4.6 11.3l6.1 2.3 2.3 6.1Z" />
            <path d="M20 4.4 10.7 13.6" />
          </svg>
        </button>
        </div>
      </div>
      {running && supportsSteer && <div className="module-composer-actions" data-testid="module-agent-send-actions">
        <span className="module-composer-hint">Enter 排队 · ⌘ / Ctrl+Enter 插话</span>
        <button type="button" className="btn btn-sm" data-testid="module-agent-steer" aria-label="插话发送" title="插入当前回答（⌘ / Ctrl+Enter）" disabled={blocked || !hasContent} onClick={() => { void submit(true) }}>插话发送</button>
      </div>}
      {supportsImages && <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="module-attach-input"
        accept={[...IMAGE_TYPES, 'text/*', 'application/json', ...TEXT_ATTACHMENT_EXTENSIONS].join(',')}
        hidden
        onChange={event => {
          if (event.target.files) addFiles(event.target.files)
          event.target.value = ''
        }}
      />}
    </div>
  )
}
