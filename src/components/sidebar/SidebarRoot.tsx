/**
 * Sidebar shell, ported from deepseek-harness's `ui-sidebar` SidebarRoot:
 * brand row + collapse, the New Session button, the workspace/session browsing
 * region (a render prop so the shell can hand it the wide flag and an expand
 * request callback), and the foot (additive actions above the settings row).
 * Collapse is a slide plus crossfade: content freezes at its expanded width
 * (inline style) and fades out in place while the sliding column clips it —
 * nothing reflows mid-slide. At settle the wide-only content unmounts and the
 * upper controls enter the 56px rail from the same horizontal offset.
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds the theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconNewChatOutline16,
  IconPanelLeftOutline16,
  IconSettingsOutline16,
  Tooltip,
} from '../../ui/primitives/index.ts'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

export interface SidebarRootProps {
  /** Current column width while expanded (px). */
  width: number
  collapsed: boolean
  onToggle: () => void
  /** pi version rendered beside the wordmark, when known. */
  piVersion: string | null
  onNewSession: () => void
  onOpenSettings: () => void
  /** The browsing region; the shell hands it the wide flag and an expand request. */
  region: (wide: boolean, expandSidebar: () => void) => ReactNode
}

/**
 * Render the sidebar column shell.
 * @param props - geometry, global actions, and the region render prop.
 * @returns the sidebar element tree.
 */
export function SidebarRoot({
  width,
  collapsed,
  onToggle,
  piVersion,
  onNewSession,
  onOpenSettings,
  region,
}: SidebarRootProps) {
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn: a portalled overlay (a row menu, a modal) is a
  // descendant in the React tree but not in the box, and must not keep the
  // bars drawn over a column nobody is pointing at.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  return (
    <div
      ref={column}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,
        collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      <div className={css.logoRow}>
        {/* Expanded, the brand doubles as a New Session shortcut; the
            collapsed rail's logo is the expand toggle below instead. */}
        {wide && (
          <button
            type="button"
            className={clsx(css.brand, css.wide)}
            aria-label="新建会话"
            onClick={() => { onNewSession() }}
          >
            <span className={css.brandIdentity} aria-hidden="true">
              <span className={css.brandMark}>
                <PiMark />
              </span>
              <span className={css.brandName}>
                <span className={css.fallbackBrandName}>pi webx</span>
                {piVersion !== null && (
                  <span className={css.localBuildTitle} style={{ alignSelf: 'flex-end', paddingBottom: 2 }}>
                    {piVersion}
                  </span>
                )}
              </span>
            </span>
          </button>
        )}
        {/* Rail resting state is the brand mark; hovering swaps in the panel
            icon (the expand affordance, figma sidebar-hover flow). */}
        <Tooltip label={collapsed ? '展开侧栏' : '收起侧栏'} delayMs={500}>
          <button
            type="button"
            className={clsx(css.iconButton, css.toggle)}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => { onToggle() }}
          >
            {!wide && (
              <span className={css.railMark} aria-hidden="true">
                <PiMark />
              </span>
            )}
            {/* Rail icons render at 18 (figma rail spec); expanded keeps the glyph-native sizes. */}
            <IconPanelLeftOutline16 className={css.panelIcon} size={wide ? 16 : 18} />
          </button>
        </Tooltip>
      </div>

      {/* Expanded, the button carries its own label — tooltip only on the rail. */}
      <Tooltip label="新建会话" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.newSession}
          aria-label="新建会话"
          onClick={() => { onNewSession() }}
        >
          <IconNewChatOutline16 size={wide ? 14 : 18} />
          {wide && <span className={clsx(css.newSessionLabel, css.wide)}>新建会话</span>}
        </button>
      </Tooltip>

      {/* The browsing region fills the column between the controls and the
          foot in both states; its rail icon column rides the same seat. */}
      <div className={css.regionArea}>
        {region(wide, () => { if (collapsed) onToggle() })}
      </div>

      {/* Footer: Settings alone, where dsh's sidebar ends. The connection state
          and the theme both moved: the first is per-session (each row carries its
          own status), and the second is a preference, which lives in the settings
          surface rather than in a rail button. */}
      <div className={css.footArea}>
        <div className={css.settingsArea}>
          <Tooltip label="设置" delayMs={500} disabled={wide}>
            <button
              type="button"
              className={clsx(css.panelRow)}
              aria-label="设置"
              aria-haspopup="dialog"
              onClick={() => { onOpenSettings() }}
              style={wide ? undefined : { width: 36, height: 36, justifyContent: 'center', padding: 0 }}
            >
              <span className={css.panelGlyph} aria-hidden="true">
                <IconSettingsOutline16 size={wide ? 16 : 18} />
              </span>
              {wide && <span className={clsx(css.panelTitle, css.wide)}>设置</span>}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

/** The π brand mark (24px box), drawn inline so the shell has no asset dependency. */
function PiMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="var(--dsw-alias-label-primary)" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="13"
        fontWeight="700"
        fill="var(--dsw-specific-sidebar-fill)"
        fontFamily=" Georgia, 'Times New Roman', serif"
      >
        π
      </text>
    </svg>
  )
}
