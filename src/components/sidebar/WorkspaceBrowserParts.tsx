/**
 * Small React parts the workspace browser shares: the document-level drag
 * acceptance both list bodies install, the view-options menu, and the rename
 * dialog plus the browser-owned state machine that drives it.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconPersonalizationOutline16,
  Menu,
  Modal,
  Tooltip,
} from '../../ui/primitives/index.ts'
import css from './WorkspaceBrowser.module.css'

/**
 * Accept the native drag at document level while a row drag is active: row
 * hover still owns the insertion marker, and releasing outside the list must
 * not be rendered as a rejected drop before dragend commits that last marker.
 */
export function useNativeDragAcceptance(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const acceptDrag = (event: DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    }
    const acceptDrop = (event: DragEvent): void => { event.preventDefault() }
    document.addEventListener('dragover', acceptDrag)
    document.addEventListener('drop', acceptDrop)
    return () => {
      document.removeEventListener('dragover', acceptDrag)
      document.removeEventListener('drop', acceptDrop)
    }
  }, [active])
}

/** Grouping and ordering menu; own open state so it resets with the wide chrome. */
export function ViewOptionsMenu({ groupBy, orderBy, onGroupPick, onOrderPick }: {
  groupBy: 'workspace' | 'flat'
  orderBy: 'manual' | 'updated'
  onGroupPick: (mode: 'workspace' | 'flat') => void
  onOrderPick: (mode: 'manual' | 'updated') => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={[
        { type: 'label' as const, id: 'group-by', text: '分组方式' },
        { id: 'workspace', label: '按工作区' },
        { id: 'flat', label: '一个列表' },
        { type: 'separator' as const, id: 'order-by-separator' },
        { type: 'label' as const, id: 'order-by', text: '排序方式' },
        { id: 'manual', label: '手动排序' },
        { id: 'updated', label: '最近更新' },
      ]}
      selectedIds={[groupBy, orderBy]}
      onSelect={(id) => {
        if (id === 'workspace' || id === 'flat') onGroupPick(id)
        else if (id === 'manual' || id === 'updated') onOrderPick(id)
        setOpen(false)
      }}
      align="end"
      dense
      // Portal: the section header clips overflow, so an in-place list would
      // be cut off at the header's bounds.
      portal
      anchor={(
        <Tooltip label="视图选项" side="bottom" delayMs={500}>
          <button
            type="button"
            className={clsx(css.iconButton, css.wide)}
            aria-label="视图选项"
            onClick={() => { setOpen(v => !v) }}
          >
            <IconPersonalizationOutline16 />
          </button>
        </Tooltip>
      )}
    />
  )
}

/** Everything the rename dialog needs from its owner. */
export interface SessionRenameState {
  /** Row the dialog is renaming, or null while the dialog is closed. */
  target: { sessionId: string; currentTitle: string } | null
  draft: string
  setDraft: (value: string) => void
  /** A rename request is in flight; the dialog stays inert until it settles. */
  renaming: boolean
  /** Confirm is refused: empty draft, or nothing to rename. */
  blocked: boolean
  /** The row menu's rename verb: open the dialog on that row. */
  open: (sessionId: string, currentTitle: string) => void
  close: () => void
  confirm: () => void
}

/**
 * Session rename dialog state (browser-owned so it outlives row unmounts).
 * Unlike workspace rename in dsh, an unchanged title is NOT blocked: confirming
 * the current automatic title is the gesture that pins it.
 */
export function useSessionRename(onRename: (id: string, name: string) => void): SessionRenameState {
  const [target, setTarget] = useState<{ sessionId: string; currentTitle: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const trimmed = draft.trim()
  const blocked = renaming || trimmed === '' || target === null
  const close = () => {
    if (renaming) return
    setTarget(null)
  }
  const confirm = () => {
    if (blocked || target === null) return
    setRenaming(true)
    Promise.resolve(onRename(target.sessionId, trimmed))
      .then(() => {
        setRenaming(false)
        setTarget(null)
      })
      .catch(() => {
        setRenaming(false)
      })
  }
  const open = (sessionId: string, currentTitle: string) => {
    setTarget({ sessionId, currentTitle })
    setDraft(currentTitle)
  }
  return { target, draft, setDraft, renaming, blocked, open, close, confirm }
}

/** Browser-owned rename dialog: the browser holds the state, this renders it. */
export function SessionRenameDialog({ open, draft, renaming, blocked, onDraftChange, onClose, onConfirm }: {
  open: boolean
  draft: string
  /** A rename request is in flight; the dialog stays inert until it settles. */
  renaming: boolean
  /** Confirm is refused: empty draft, or nothing to rename. */
  blocked: boolean
  onDraftChange: (value: string) => void
  onClose: () => void
  onConfirm: () => void
}) {
  /** Composition flag: Enter inside an IME composition must not submit. */
  const composingRef = useRef(false)
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel="关闭"
      title="重命名会话"
      footer={(
        <>
          <Button variant="outline" disabled={renaming} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={blocked} onClick={onConfirm}>重命名</Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={draft}
        aria-label="会话名称"
        autoFocus
        disabled={renaming}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { onDraftChange(e.target.value) }}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composingRef.current) {
            e.preventDefault()
            onConfirm()
          }
        }}
      />
    </Modal>
  )
}
