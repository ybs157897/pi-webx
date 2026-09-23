/**
 * 通用展示组件与浏览器状态 hook：卡片、统计块、空状态、弹窗、头像、标签、
 * 分段控件、Toast 容器。模块只拼这些积木，不各自造一套外观。
 * @module src/ui
 */

import { useEffect, useId, useState } from 'react'
import { IconClose } from './icons.jsx'
import { safeImageUrl } from './util.mjs'

/**
 * 卡片容器（玻璃底 + 标题行）。
 * @param props - `title`/`subtitle`/`action` 为头部元素，其余进 `children`。
 * @returns 卡片元素。
 */
export function Card({ title, subtitle, action, children, className = '', bodyClassName = '' }) {
  const hasHead = title !== undefined || action !== undefined
  return (
    <section className={`card ${className}`}>
      {hasHead && (
        <header className="card-head">
          <div>
            {title !== undefined && <h3 className="card-title">{title}</h3>}
            {subtitle !== undefined && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {action !== undefined && <div className="card-action">{action}</div>}
        </header>
      )}
      <div className={`card-body ${bodyClassName}`}>{children}</div>
    </section>
  )
}

/**
 * 概述数字块。
 * @param props - `value` 主数字，`unit` 尾缀，`tone` 取 `ok`/`warn`/`danger`。
 * @returns 统计块元素。
 */
export function Stat({ icon, label, value, unit, tone = '', hint }) {
  return (
    <div className={`stat ${tone}`}>
      <div className="stat-top">
        {icon !== undefined && <span className="stat-icon">{icon}</span>}
        <span className="stat-label">{label}</span>
      </div>
      <p className="stat-value">
        {value}
        {unit !== undefined && <em>{unit}</em>}
      </p>
      {hint !== undefined && <p className="stat-hint">{hint}</p>}
    </div>
  )
}

/**
 * 空状态：图标 + 一句话 + 可选的行动按钮。
 * @param props - `action` 通常是一个 `.btn`。
 * @returns 空状态元素。
 */
export function Empty({ icon, title, hint, action }) {
  return (
    <div className="empty">
      {icon !== undefined && <span className="empty-icon">{icon}</span>}
      <p className="empty-title">{title}</p>
      {hint !== undefined && <p className="empty-hint">{hint}</p>}
      {action !== undefined && <div className="empty-action">{action}</div>}
    </div>
  )
}

/** 小标签（不可点）。`tone` 取 `ok`/`warn`/`danger`/`accent`。 */
export function Chip({ tone = '', children }) {
  return <span className={`chip ${tone}`}>{children}</span>
}

/** 可点标签（过滤/建议问题）。 */
export function ChipButton({ tone = '', active = false, onClick, children, title }) {
  return (
    <button type="button" className={`chip chip-btn ${tone} ${active ? 'is-active' : ''}`} onClick={onClick} title={title}>
      {children}
    </button>
  )
}

/** 图标按钮；必须给 `label`（进 `aria-label` 与 tooltip）。 */
export function IconButton({ label, onClick, children, tone = '', disabled = false, type = 'button', className = '' }) {
  return (
    <button
      type={type}
      className={`icon-btn ${tone} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

/**
 * 头像一个：有图显示图，没图显示首字。
 * @param props - `src` 为 `/uploads/...` 同源地址。
 * @returns 头像元素。
 */
export function Avatar({ src, name, size = 72 }) {
  const style = { width: `${size}px`, height: `${size}px` }
  const initial = String(name ?? '').trim().slice(0, 1)
  const href = safeImageUrl(src)
  if (href !== '') {
    return <img className="avatar" src={href} alt={String(name ?? '头像')} style={style} loading="lazy" />
  }
  return (
    <span className="avatar avatar-fallback" style={{ ...style, fontSize: `${Math.round(size * 0.38)}px` }} aria-hidden="true">
      {initial === '' ? '·' : initial}
    </span>
  )
}

/**
 * 单控件字段容器。用 `<label>` 包住控件，点标签即聚焦/切换该控件。
 * 字段里是一组按钮（分段控件、心情选择）时改用 `FieldGroup`：`<label>` 会把
 * 点击转给第一个按钮，造成「点标签就选了第一项」的意外。
 * @returns 字段元素。
 */
export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="field-hint">{hint}</span>}
    </label>
  )
}

/** 分组控件的字段容器：语义与 `Field` 相同，但不做点击转发。 */
export function FieldGroup({ label, hint, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="field-hint">{hint}</span>}
    </div>
  )
}

/**
 * 分段控件（单选）。
 * @param props - `options` 为 `{ value, label }` 数组。
 * @returns 分段控件元素。
 */
export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className={`segmented-item ${option.value === value ? 'is-active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * 模态框骨架（Esc 关闭、点遮罩关闭、焦点留在对话框内）。
 * @param props - `footer` 放在底部操作区，跟表单按钮一起用时配 `type="submit"` + `form` 属性。
 * @returns 模态框元素；`open` 为 false 时返回 null。
 */
export function Modal({ open, title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h3 className="modal-title">{title}</h3>
          <IconButton label="关闭" onClick={onClose}>
            <IconClose size={18} />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

/**
 * 表单弹窗：自带 `<form>` 与「取消 / 保存」底栏，模块只写字段。
 * @param props - `onSubmit` 由调用方负责提交并 `busy` 期间禁用保存。
 * @returns 模态框元素。
 */
export function FormModal({
  open, title, onClose, onSubmit, submitText = '保存', busy = false, children, wide = false, hint,
}) {
  const formId = useId()
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      wide={wide}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={busy}>
            {busy ? '保存中…' : submitText}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        onSubmit={event => {
          event.preventDefault()
          onSubmit()
        }}
      >
        {children}
        {hint !== undefined && <p className="form-hint">{hint}</p>}
      </form>
    </Modal>
  )
}

/**
 * 删除确认：不可撤销的操作都过一遍这里。
 * @param props - `onConfirm` 期间 `busy` 会禁用两个按钮。
 * @returns 模态框元素。
 */
export function ConfirmDialog({ open, title = '确认删除', message, confirmText = '删除', onCancel, onConfirm, busy = false }) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-danger-solid" onClick={onConfirm} disabled={busy}>
            {busy ? '删除中…' : confirmText}
          </button>
        </>
      }
    >
      <p className="confirm-message">{message}</p>
    </Modal>
  )
}

/** Toast 容器（App 持有队列，2.6s 自动消失）。 */
export function ToastHost({ toasts }) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast ${toast.tone}`}>
          {toast.text}
        </div>
      ))}
    </div>
  )
}

/**
 * 订阅一个媒体查询。
 * @param query - CSS 媒体查询字符串。
 * @returns 是否匹配。
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (
    typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? false : window.matchMedia(query).matches
  ))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const list = window.matchMedia(query)
    setMatches(list.matches)
    const onChange = event => setMatches(event.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}
