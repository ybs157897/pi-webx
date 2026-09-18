/**
 * The settings page — the reference's layout: a full-layer page with its own
 * nav rail on the left and, to its right, a panel holding the section in a
 * centered column under a large title. It replaces the app's content while
 * open (no mask, no floating panel), so working in settings is working in the
 * app, not above it.
 *
 * Sections arrive as props instead of through registrant slots, grouped by the
 * order their `group` first appears. Paths back: the 返回工作区 rail row at the
 * top and Escape (mounted only while open, so the listener lifetime is the
 * page's).
 */

import { useEffect, useRef, useState } from 'react'
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
  /** Nav cell label. */
  label: string
  /** Nav group the cell sits under; groups render in first-appearance order. */
  group?: string
  /** Page title above the section content. */
  title: string
  /** Render the section: content column of the centered page column. */
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

/** The sections grouped for the rail, in first-appearance order. */
function navGroups(sections: readonly SettingsSection[]): { label: string; items: SettingsSection[] }[] {
  const groups: { label: string; items: SettingsSection[] }[] = []
  for (const section of sections) {
    const label = section.group ?? ''
    const group = groups.find(candidate => candidate.label === label)
    if (group === undefined) groups.push({ label, items: [section] })
    else group.items.push(section)
  }
  return groups
}

/**
 * Render the settings page.
 * @param props - open state, back contract, and sections.
 * @returns the page tree, or null while closed.
 */
export function SettingsPage({ open, onClose, sections }: SettingsPageProps): ReactNode {
  const [activeId, setActiveId] = useState<string | undefined>(undefined)

  /* The back contract arrives as an inline callback, so its identity changes on
     every parent render — and the app re-renders on its session poll. Reading it
     through a ref keeps the effect below keyed on `open` alone: binding it to
     `onClose` would re-run on every poll, and re-running means resetting the
     active section back to the first row. */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

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
  const active = sections.find(section => section.id === activeId) ?? sections[0]

  return (
    <div className={css.page} role="region" aria-label="设置">
      <aside className={css.rail}>
        <div className={css.railTop} aria-hidden="true" />
        <div className={css.railBack}>
          <button type="button" className={css.backRow} onClick={onClose}>
            <IconChevronLeftOutline14 size={16} />
            <span>返回工作区</span>
          </button>
        </div>
        <nav className={css.railNav} aria-label="设置导航">
          {navGroups(sections).map(group => (
            <div className={css.navGroup} key={group.label} role="group" aria-label={group.label}>
              {group.label === '' ? null : <div className={css.navGroupLabel}>{group.label}</div>}
              <div className={css.navGroupList}>
                {group.items.map(section => (
                  <button
                    key={section.id}
                    type="button"
                    className={clsx(css.navCell, section.id === active?.id && css.navCellActive)}
                    aria-current={section.id === active?.id ? 'page' : undefined}
                    onClick={() => { setActiveId(section.id) }}
                  >
                    {navIcon(section.id)}
                    <span className={css.navLabel}>{section.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>
      <section className={css.contentFrame}>
        <div className={css.panel}>
          <div className={css.panelHeader} aria-hidden="true" />
          <main className={css.panelBody}>
            <div className={css.column}>
              <h2 className={css.pageTitle}>{active?.title}</h2>
              <div className={css.sectionBody}>{active?.render()}</div>
            </div>
          </main>
        </div>
      </section>
    </div>
  )
}
