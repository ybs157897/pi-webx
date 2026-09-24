/**
 * The sub-agent section's presentational parts: the labelled field shell, the
 * colour swatches, one tool tick, a row's action cluster, the issues lists, the
 * unsaved-edits dialog and the one-line notice.
 *
 * Two neighbours deliberately stay in `AgentDefinitionsSection.tsx` instead:
 * the row body and the delete confirmation, because
 * `scripts/check-agent-definitions-ui.ts` pins their source text to that file
 * (the `readOnly` branch and the verbatim delete copy). Everything here takes
 * its copy from the caller, so the section remains the one place that renders
 * the reference's zh-CN strings in order.
 */

import type { ReactNode } from 'react'
import {
  AGENT_COLOR_LABELS,
  AGENT_COLOR_ORDER,
  type AgentColorName,
  type AgentFormProblems,
} from './agent-definitions-form.ts'
import type { AgentNotice } from './use-agent-form.ts'
import { Button, IconTrashOutline16, Modal } from '../../ui/primitives/index.ts'
import styles from './AgentDefinitionsSection.module.css'

/** One labelled field block, matching the reference's `FormFieldLabel` spacing. */
export function Field({ label, htmlFor, children }: {
  label: string
  htmlFor?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className={styles.field}>
      <label className={styles.label} {...(htmlFor === undefined ? {} : { htmlFor })}>{label}</label>
      {children}
    </div>
  )
}

/** The colour swatch row: one button per colour, the selected one highlighted.
 *
 * Pressing a swatch is reported as-is; the caller decides whether that sets or
 * clears the colour (clicking the selected swatch clears it).
 */
export function AgentColorPicker({ label, color, onSelect }: {
  label: string
  color: AgentColorName | undefined
  onSelect: (color: AgentColorName) => void
}): ReactNode {
  return (
    <div className={styles.colorRow} role="group" aria-label={label}>
      {AGENT_COLOR_ORDER.map((option) => (
        <button
          key={option}
          type="button"
          className={color === option
            ? `${styles.colorSwatch} ${styles.colorSwatchActive}`
            : styles.colorSwatch}
          aria-pressed={color === option}
          aria-label={AGENT_COLOR_LABELS[option]}
          title={AGENT_COLOR_LABELS[option]}
          onClick={() => { onSelect(option) }}
        >
          <span className={styles.colorDot} data-color={option} />
        </button>
      ))}
      {color === undefined
        ? null
        : <span className={styles.hint}>{AGENT_COLOR_LABELS[color]}</span>}
    </div>
  )
}

/** One tool tick, mirroring the reference's `ToolCheckbox` (:400-440). */
export function ToolCheckbox({ label, title, checked, onToggle }: {
  label: string
  title: string
  checked: boolean
  onToggle: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      className={styles.toolItem}
      onClick={onToggle}
    >
      <span
        className={checked ? `${styles.tickBox} ${styles.tickBoxOn}` : styles.tickBox}
        aria-hidden="true"
      >
        {checked ? '✓' : ''}
      </span>
      <span className={styles.toolName}>{label}</span>
    </button>
  )
}

/** A row's action cluster: the enable switch and the delete icon.
 *
 * Both callbacks are optional because the row's own policy decides whether the
 * cluster is rendered at all — a read-only row renders nothing here, and one
 * that renders it always hands both in.
 */
export function AgentRowActions({ name, enabled, busy, onToggle, onDelete }: {
  name: string
  enabled: boolean
  busy: boolean
  onToggle?: ((enabled: boolean) => void) | undefined
  onDelete?: (() => void) | undefined
}): ReactNode {
  return (
    <div className={styles.agentActions}>
      <label className={styles.switchRow}>
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={busy}
          aria-label={`切换 ${name}`}
          onChange={(event) => { onToggle?.(event.target.checked) }}
        />
      </label>
      <button
        type="button"
        className={styles.iconButton}
        disabled={busy}
        title="删除"
        aria-label={`删除 ${name}`}
        onClick={onDelete}
      >
        <IconTrashOutline16 size={16} />
      </button>
    </div>
  )
}

/** The draft's non-blocking warnings and blocking errors, as the form's two lists. */
export function AgentFormIssues({ problems, formError }: {
  problems: AgentFormProblems
  formError: string | undefined
}): ReactNode {
  return (
    <>
      {problems.warnings.length > 0 && (
        <ul className={styles.hint}>
          {problems.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}

      {(formError !== undefined || problems.errors.length > 0) && (
        <ul className={styles.errorList} role="alert">
          {(formError !== undefined ? [formError] : problems.errors).map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
    </>
  )
}

/** The one-line result message (info / error / success), or nothing. */
export function NoticeLine({ notice }: { notice: AgentNotice | undefined }): ReactNode {
  if (notice === undefined) return null
  return (
    <p
      className={notice.tone === 'error'
        ? `${styles.notice} ${styles.noticeAlert}`
        : notice.tone === 'success' ? `${styles.notice} ${styles.noticeSuccess}` : styles.notice}
      role={notice.tone === 'error' ? 'alert' : 'status'}
    >
      {notice.text}
    </p>
  )
}

/** Unsaved-edits guard (ours; the reference returns straight to the list). */
export function DiscardDialog({ open, onCancel, onConfirm }: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="放弃未保存的修改"
      closeLabel="关闭"
      description="当前表单有未保存的修改，继续操作会丢弃它们。"
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>继续编辑</Button>
          <Button variant="primary" size="sm" onClick={onConfirm}>放弃修改</Button>
        </>
      )}
    >
      <p className={styles.hint}>可以先「保存」，再切换。</p>
    </Modal>
  )
}
