/**
 * The settings page — the reference's layout: a full-layer page with its own
 * nav rail on the left and the section content on the right. It replaces the
 * app's content while open (no mask, no floating panel), so working in
 * settings is working in the app, not above it.
 *
 * Sections arrive as props instead of through registrant slots. Paths back:
 * the 返回工作区 nav row at the top and Escape (mounted only while open, so
 * the listener lifetime is the page's).
 */

import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import {
  IconChevronLeftOutline14,
  IconDataOutline16,
  IconSettingsOutline16,
} from '../../ui/primitives/index.ts'
import css from './SettingsRoot.module.css'

/** One nav-rail section the page can show. */
export interface SettingsSection {
  /** Section id; picks the nav glyph. */
  id: string
  /** Nav label. */
  label: string
  /** Render the section's content column. */
  render: () => ReactNode
}

/** Props of {@link SettingsPage}. */
export interface SettingsPageProps {
  /** Whether the page is showing. */
  open: boolean
  /** Leave settings: the back row or Escape. */
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
 * Render the settings page.
 * @param props - open state, back contract, and sections.
 * @returns the page tree, or null while closed.
 */
export function SettingsPage({ open, onClose, sections }: SettingsPageProps): ReactNode {
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const titleId = useId()

  /* The back contract arrives as an inline callback, so its identity changes on
     every parent render — and the app re-renders on its session poll. Reading it
     through a ref keeps the effect below keyed on `open` alone: binding it to
     `onClose` would re-run on every poll, and re-running means resetting the
     active section back to the first row. */
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    if (!open) return
    setActiveId(undefined)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  if (!open) return null

  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = sections.find(section => section.id === activeId)?.id ?? sections[0]?.id

  return (
    <div className={css.page} role="region" aria-label="设置">
      <nav className={css.nav}>
        <button type="button" className={css.backRow} onClick={onClose}>
          <IconChevronLeftOutline14 />
          <span>返回工作区</span>
        </button>
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
        <div className={css.options}>
          {active !== undefined && sections.find(section => section.id === active)?.render()}
        </div>
      </div>
    </div>
  )
}
