/**
 * The composer's branch control: which branch the workspace is on, and a way to
 * switch it.
 *
 * pi reports a branch (`cwd (branch)`, in its TUI footer) but nothing switches
 * one, so this is pi-webx's own surface — built in the shape of its neighbours
 * in the same toolbar row (`ToolPresetSelect`): a pill that opens a list, with
 * the current entry marked. It disappears outside a repository rather than
 * offering an action git would refuse.
 *
 * Refresh policy is deliberately dull: read when the workspace changes, after a
 * switch, and when a run finishes (the agent may have checked something out
 * itself). No poll — `git` is a process, and a composer that spawns one every
 * few seconds is a worse neighbour than a slightly stale label.
 */

import { Popover, theme } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Check, GitBranch } from 'lucide-react';

import { api } from '../lib/api';
import type { GitBranchView } from '../shared/git';

export interface BranchSelectProps {
  /** Absolute path of the workspace the branch is read from. */
  cwd: string;
  /** Disable every control (a pending write). */
  disabled?: boolean;
  /**
   * Whether a run is in flight. A switch back to idle re-reads the branch: the
   * agent's own `git checkout` would otherwise leave this label lying.
   */
  running?: boolean;
  /** A switch failed; the shell owns how that is shown. */
  onError?: ((message: string) => void) | undefined;
}

/** What the pill prints: the branch, or the short sha of a detached HEAD. */
function labelOf(view: GitBranchView | null): string | null {
  if (view === null || !view.repo) return null;
  if (view.branch !== null) return view.branch;
  return view.head !== undefined ? `${view.head} (游离)` : '游离 HEAD';
}

export function BranchSelect({ cwd, disabled = false, running = false, onError }: BranchSelectProps) {
  const { token } = theme.useToken();
  const [view, setView] = useState<GitBranchView | null>(null);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async (): Promise<void> => {
    try {
      setView(await api.gitBranches(cwd));
    } catch {
      // A workspace that cannot be read (removed, unreadable) simply has no
      // branch control; the failure surfaces where the workspace itself does.
      setView(null);
    }
  }, [cwd]);

  /**
   * Read on mount, on a workspace change (`read` is keyed to `cwd`), and when a
   * run ends — the moment the agent may have checked something out itself.
   * Nothing is read while a run is in flight: the answer would be stale before
   * it rendered, and the switch is unavailable anyway.
   */
  useEffect(() => {
    if (running) return;
    void read();
  }, [running, read]);

  const pick = (branch: string): void => {
    setOpen(false);
    setBusy(true);
    void (async () => {
      try {
        setView(await api.gitCheckout({ cwd, branch }));
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
        // Re-read rather than guess: a refused checkout changes nothing, but the
        // failure may itself have been a stale branch list.
        await read();
      } finally {
        setBusy(false);
      }
    })();
  };

  const label = labelOf(view);
  if (label === null) return null;

  const content = (
    <div style={{ width: 264, maxHeight: 320, overflowY: 'auto' }}>
      {(view?.branches ?? []).map((branch) => (
        <button
          key={branch}
          type="button"
          disabled={busy}
          onClick={() => { pick(branch); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            padding: '6px 8px',
            borderStyle: 'none',
            borderRadius: token.borderRadius,
            background: branch === view?.branch ? token.colorPrimaryBg : 'transparent',
            color: 'inherit',
            fontFamily: 'inherit',
            fontSize: 13,
            textAlign: 'start',
            cursor: busy ? 'progress' : 'pointer',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {branch}
          </span>
          {branch === view?.branch && (
            <Check size={14} style={{ color: token.colorPrimary, flexShrink: 0 }} />
          )}
        </button>
      ))}
      {(view?.branches.length ?? 0) === 0 && (
        <p style={{ margin: '4px 8px 0', fontSize: 11, color: token.colorTextQuaternary }}>
          这个仓库还没有本地分支
        </p>
      )}
    </div>
  );

  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={false}
      destroyOnHidden
      open={open && !disabled}
      onOpenChange={(next) => { if (!disabled) setOpen(next); }}
      content={content}
      styles={{ container: { padding: 6 }, content: { padding: 0 } }}
    >
      <button
        type="button"
        disabled={disabled || busy}
        aria-label={`当前分支：${label}`}
        onMouseEnter={() => { setHovered(true); }}
        onMouseLeave={() => { setHovered(false); }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 24,
          maxWidth: 200,
          paddingInline: 8,
          borderStyle: 'none',
          borderRadius: 999,
          background: open || hovered ? token.colorFillTertiary : 'transparent',
          color: token.colorTextSecondary,
          fontFamily: 'inherit',
          fontSize: 12,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <GitBranch size={13} style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
      </button>
    </Popover>
  );
}
