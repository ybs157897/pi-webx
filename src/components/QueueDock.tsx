/**
 * The messages waiting behind the running turn — dsh's `QueueDock`.
 *
 * A message sent while the agent is working is not lost and not shouted into the
 * running turn: it lands here, one row per message, and the turn that carries it
 * starts when the current one settles. Every row is addressable, which is the
 * part the dock exists for:
 *
 *   插话发送  move this row into the running turn (pi's `steer`, delivered after
 *            the current assistant turn's tool calls) — allowed only while a
 *            turn is running, because that is the only window a steer has;
 *   编辑      rewrite the text before it is sent;
 *   删除      drop it.
 *
 * One row renders bare; several collapse under a "{n} 条排队消息" header, which
 * is dsh's rule and the reason a single queued line never costs an extra click.
 */

import { useEffect, useState } from 'react';

import type { PiQueuedPrompt } from '../shared/protocol';
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCloseOutline16,
  IconEditOutline16,
  IconPaperclipOutline16,
  IconQueueOutline14,
  IconSendOutline14,
  IconTrashOutline16,
  Tooltip,
} from '../ui/primitives/index.ts';
import css from './QueueDock.module.css';

const COPY = {
  count: (n: number) => `${String(n)} 条排队消息`,
  edit: '编辑排队消息',
  save: '保存排队消息',
  cancelEdit: '取消编辑',
  remove: '删除排队消息',
  steer: '插话发送',
  steerUnavailable: '仅运行中可插话发送',
  image: '排队消息图片',
};

export interface QueueDockProps {
  items: PiQueuedPrompt[];
  /** A turn is running: the only state in which a row may be steered. */
  running: boolean;
  /** All three answer when the host has applied the action, not when it is asked. */
  onSteer: (id: string) => Promise<void>;
  onEdit: (id: string, text: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

export function QueueDock({ items, running, onSteer, onEdit, onRemove }: QueueDockProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  /** The row an action is in flight for: its controls go quiet until it settles. */
  const [busy, setBusy] = useState<string | null>(null);

  const rowCount = items.length;

  // A row can leave the queue while it is being edited (the turn claimed it), in
  // which case the editor has nothing left to save.
  useEffect(() => {
    if (editing !== null && !items.some((row) => row.id === editing.id)) setEditing(null);
    if (busy !== null && !items.some((row) => row.id === busy)) setBusy(null);
  }, [busy, editing, items]);
  useEffect(() => {
    if (rowCount <= 1 && !collapsed) setCollapsed(true);
  }, [collapsed, rowCount]);

  if (rowCount === 0) return null;

  const expanded = !collapsed || editing !== null;
  // One row needs no disclosure: its own line is the whole dock.
  const listVisible = rowCount === 1 || expanded;
  const interactionActive = editing !== null || busy !== null;

  /**
   * Run one row action and keep that row's controls quiet until the host has
   * answered — the row can be claimed by the running turn in between, and a
   * second click on a row that no longer exists has nothing to act on.
   */
  const run = (id: string, action: () => Promise<void>): void => {
    setBusy(id);
    void action()
      .catch(() => {})
      .finally(() => { setBusy((current) => (current === id ? null : current)); });
  };

  const saveEdit = () => {
    if (editing === null) return;
    const text = editing.text.trim();
    if (text.length === 0) return;
    const id = editing.id;
    run(id, async () => {
      await onEdit(id, text);
      setEditing((current) => (current?.id === id ? null : current));
    });
  };

  return (
    <div className={css.dock} data-queue-dock="">
      {rowCount > 1 && (
        <button
          type="button"
          className={css.header}
          aria-expanded={expanded}
          disabled={interactionActive}
          onClick={() => { setCollapsed((value) => !value); }}
        >
          <span className={css.lead} aria-hidden="true">
            <IconQueueOutline14 />
          </span>
          <span className={css.count}>{COPY.count(rowCount)}</span>
          <span className={css.lead} aria-hidden="true">
            {expanded ? <IconChevronDownOutline14 /> : <IconChevronUpOutline14 />}
          </span>
        </button>
      )}

      {listVisible && (
        <ul className={css.list}>
          {items.map((row) => (
            <li key={row.id} className={css.row}>
              {rowCount === 1 && (
                <span className={css.lead} aria-hidden="true">
                  <IconQueueOutline14 />
                </span>
              )}

              {row.imageCount > 0 && (
                <span className={css.attachments}>
                  <span className={css.attachment} title={COPY.image}>
                    <IconPaperclipOutline16 size={12} />
                    {row.imageCount}
                  </span>
                </span>
              )}

              {editing?.id === row.id ? (
                <input
                  autoFocus
                  className={css.editor}
                  aria-label={COPY.edit}
                  value={editing.text}
                  onChange={(event) => { setEditing({ id: row.id, text: event.target.value }); }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setEditing(null);
                      return;
                    }
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      saveEdit();
                    }
                  }}
                />
              ) : (
                <span className={css.preview} title={row.text}>
                  {row.text}
                </span>
              )}

              <div className={css.actions}>
                {editing?.id === row.id ? (
                  <>
                    <Tooltip label={COPY.save} side="bottom">
                      <button
                        type="button"
                        className={css.action}
                        aria-label={COPY.save}
                        disabled={busy !== null || editing.text.trim().length === 0}
                        onClick={saveEdit}
                      >
                        <IconCheckOutline16 size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip label={COPY.cancelEdit} side="bottom">
                      <button
                        type="button"
                        className={css.action}
                        aria-label={COPY.cancelEdit}
                        disabled={busy !== null}
                        onClick={() => { setEditing(null); }}
                      >
                        <IconCloseOutline16 size={14} />
                      </button>
                    </Tooltip>
                  </>
                ) : (
                  <>
                    <Tooltip label={COPY.edit} side="bottom">
                      <button
                        type="button"
                        className={css.action}
                        aria-label={COPY.edit}
                        disabled={busy !== null}
                        onClick={() => { setEditing({ id: row.id, text: row.text }); }}
                      >
                        <IconEditOutline16 size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip label={COPY.remove} side="bottom">
                      <button
                        type="button"
                        className={css.action}
                        aria-label={COPY.remove}
                        disabled={busy !== null}
                        onClick={() => { run(row.id, () => onRemove(row.id)); }}
                      >
                        <IconTrashOutline16 size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip
                      label={running ? COPY.steer : COPY.steerUnavailable}
                      side="bottom"
                    >
                      <button
                        type="button"
                        className={css.action}
                        aria-label={COPY.steer}
                        disabled={busy !== null || !running}
                        onClick={() => { run(row.id, () => onSteer(row.id)); }}
                      >
                        <IconSendOutline14 />
                      </button>
                    </Tooltip>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
