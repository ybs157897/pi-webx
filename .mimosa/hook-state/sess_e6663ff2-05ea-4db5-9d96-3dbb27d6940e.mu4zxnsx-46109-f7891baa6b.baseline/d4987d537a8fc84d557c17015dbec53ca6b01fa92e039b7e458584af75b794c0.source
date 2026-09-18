/**
 * The settings modal shell, ported from dsh's `ui-settings-general`
 * SettingsRoot: full-viewport mask + centered 800px panel with the section nav
 * rail. The trigger row lives in the sidebar foot (pi-webx's SidebarRoot), so
 * this component is the panel alone; sections arrive as props instead of
 * through registrant slots. Close paths: the header button, a mask click, and
 * document-level Escape (mounted only while open, so the listener lifetime is
 * the panel's).
 */

import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import {
  IconDataOutline16,
  IconCloseOutline16,
  IconSettingsOutline16,
} from '../../ui/primitives/index.ts'
import css from './SettingsRoot.module.css'

/** One nav-rail section the shell can show. */
export interface SettingsSection {
  /** Section id; picks the nav glyph. */
  id: string
  /** Nav label. */
  label: string
  /** Render the section's content column. */
  render: () => ReactNode
}

/** Props of {@link SettingsModal}. */
export interface SettingsModalProps {
  /** Whether the panel is showing. */
  open: boolean
  /** Close: header button, mask click, or Escape. */
  onClose: () => void
  /** The sections, in nav order. */
  sections: readonly SettingsSection[]
}

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string): ReactNode {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

/**
 * Render the settings modal panel.
 * @param props - open state, close contract, and sections.
 * @returns the overlay tree, or null while closed.
 */
export function SettingsModal({ open, onClose, sections }: SettingsModalProps): ReactNode {
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    setActiveId(undefined)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    // Entering the dialog focuses the close button.
    closeButton.current?.focus()
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, onClose])

  if (!open) return null

  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = sections.find(section => section.id === activeId)?.id ?? sections[0]?.id

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId}>设置</div>
          <div className={css.navList}>
            {sections.map(section => (
              <button
                key={section.id}
                type="button"
                className={clsx(css.navCell, section.id === active && css.active)}
                aria-current={section.id === active ? 'true' : undefined}
                onClick={() => { setActiveId(section.id) }}
              >
                {navIcon(section.id)}
                <span className={css.navLabel}>{section.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions} />
            <button
              ref={closeButton}
              type="button"
              className={css.close}
              aria-label="关闭设置"
              onClick={onClose}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && sections.find(section => section.id === active)?.render()}
          </div>
        </div>
      </div>
    </div>
  )
}
