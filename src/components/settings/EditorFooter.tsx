/**
 * The action row every provider card ends with: dismiss on the left, commit on
 * the right. Ported from dsh's EditorFooter with the locale keys replaced by
 * plain strings — the cards keep sole ownership of when a commit is allowed
 * and what the in-flight wording is.
 */

import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'

/** Props of {@link EditorFooter}. */
export interface EditorFooterProps {
  /** Whether a commit is in flight; holds Cancel and swaps the commit label. */
  busy: boolean
  /** Whether the commit is refused, as judged by the owning card. */
  submitDisabled: boolean
  /** Commit label while idle. */
  submitLabel: string
  /** Commit label while a commit is in flight. */
  submitBusyLabel: string
  /** Dismiss label. */
  cancelLabel: string
  /** Dismiss the card without committing. */
  onCancel: () => void
  /** Run the card's commit. */
  onSubmit: () => void
}

/** Render one provider card's action row. */
export function EditorFooter(props: EditorFooterProps): ReactNode {
  return (
    <div className={styles['editorActions']}>
      <button
        type="button"
        className={styles['secondaryButton']}
        disabled={props.busy}
        onClick={props.onCancel}
      >
        {props.cancelLabel}
      </button>
      <button
        type="button"
        className={styles['primaryButton']}
        disabled={props.submitDisabled}
        onClick={props.onSubmit}
      >
        {props.busy ? props.submitBusyLabel : props.submitLabel}
      </button>
    </div>
  )
}
