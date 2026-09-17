/**
 * Workspace tree: the sidebar's main region — every live and persisted pi session
 * grouped under the workspace (working directory) it belongs to, modelled on the
 * workspace-grouped session tree of deepseek-harness's `ui-workspace` rows.
 *
 * Each workspace row carries a folder icon that swaps open/closed with expansion, a
 * chevron that shows on hover (and stays visible while expanded) and the workspace
 * title; hover also reveals a "new session here" button plus the workspace overflow
 * menu, while the row body itself toggles the expansion. Sessions sit underneath:
 * live ones first (status dot + stronger text), then the persisted transcripts
 * (history icon + secondary text).
 *
 * Self-contained and purely presentational: every datum arrives through props, the
 * only local state is the search query, the per-workspace expansion, the optimistic
 * rename names, the per-workspace "show all rows" flag and the open row menus —
 * nothing is fetched, and no wall clock is read while rendering beyond the relative
 * labels derived from the prop timestamps.
 */

import { ActionIcon, Flexbox, Icon, Text, Tooltip } from '@lobehub/ui';
import { App, Dropdown, Empty, Input, Modal, Tag, theme } from 'antd';
import type { MenuProps, ModalFuncProps } from 'antd';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Ellipsis,
  Folder,
  FolderOpen,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FC, ReactNode } from 'react';

import { formatRelativeTime, truncate } from '../lib/format';
import type { SessionSummary, StoredSession } from '../shared/protocol';

/** Dense rows so a long history stays scannable. */
const ROW_HEIGHT = 40;
/** Workspace headers are slightly tighter than the rows they own. */
const WORKSPACE_ROW_HEIGHT = 32;
/** Rows rendered per workspace before the 「展开其余 N 条」 toggle appears. */
const MAX_VISIBLE_ROWS = 6;
/** Left slot shared by both row kinds, so their titles line up with the folder. */
const LEAD_SLOT = 14;

/**
 * Pulsing halo for the streaming dot. Inlined because the component must stay
 * self-contained; a duplicated `<style>` tag per instance is harmless. The reduced
 * motion clause keeps the dot readable for users who opt out of animation.
 */
const PULSE_STYLE = `@keyframes pi-workspace-tree-pulse{0%{transform:scale(1);opacity:.55}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}@media (prefers-reduced-motion: reduce){[data-part="status-pulse"]{animation:none !important}}`;

/* ------------------------------------------------------------------ helpers */

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** `/Users/x/work/api` → `~/work/api` when it lives under the reported home dir. */
function shortenCwd(path: string, home: string | undefined): string {
  if (home !== undefined && home.length > 0 && path.startsWith(home)) {
    const rest = path.slice(home.length);
    return rest.length === 0 ? '~' : `~${rest}`;
  }
  return path;
}

/** Case-insensitive substring match over every displayed field of a row. */
function matchesQuery(needle: string, parts: readonly (string | null | undefined)[]): boolean {
  if (needle.length === 0) return true;
  return parts.some((part) => typeof part === 'string' && part.toLowerCase().includes(needle));
}

/** Row headline for a stored session: the preview, else an id stub. */
function storedTitleOf(session: StoredSession): string {
  return isNonEmptyString(session.preview) ? truncate(session.preview, 60) : session.id.slice(0, 12);
}

/**
 * antd's context `modal`/`message` inherit the app theme; outside an `<App>` the
 * context default is an empty object, so fall back to the static Modal API.
 */
function useAntdFeedback(): {
  confirm: (config: ModalFuncProps) => void;
  success: ((content: ReactNode, duration?: number) => void) | undefined;
} {
  const app = App.useApp();
  return useMemo(() => {
    const modal = app.modal as Partial<typeof app.modal>;
    const message = app.message as Partial<typeof app.message>;
    const confirm = modal.confirm ?? Modal.confirm;
    return {
      confirm: (config: ModalFuncProps) => {
        confirm(config);
      },
      success: message.success,
    };
  }, [app.message, app.modal]);
}

/* --------------------------------------------------------------- primitives */

function CountBadge({ count, muted }: { count: number; muted?: boolean }) {
  const { token } = theme.useToken();
  return (
    <Text
      data-part="count-badge"
      fontSize={10.5}
      style={{
        flexShrink: 0,
        minWidth: 18,
        paddingInline: 5,
        lineHeight: '16px',
        textAlign: 'center',
        borderRadius: 8,
        background: token.colorFillTertiary,
        color: muted === true ? token.colorTextQuaternary : token.colorTextSecondary,
      }}
    >
      {count}
    </Text>
  );
}

function EmptyState({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <Flexbox
      align="center"
      justify="center"
      data-part="empty-state"
      style={{ paddingBlock: 32, color: token.colorTextQuaternary }}
    >
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />
    </Flexbox>
  );
}

/**
 * The right edge of a session row: the relative time normally, the overflow menu
 * once the row is hovered (or its menu is open). Both live in the same fixed slot
 * so swapping them never moves the row, and the Dropdown stays mounted at all times
 * (only its opacity flips) so the menu does not have to be rebuilt on hover.
 */
function RowTail({
  time,
  hovered,
  items,
  onMenuClick,
}: {
  time: string;
  hovered: boolean;
  items: NonNullable<MenuProps['items']>;
  onMenuClick: NonNullable<MenuProps['onClick']>;
}) {
  const { token } = theme.useToken();
  const [menuOpen, setMenuOpen] = useState(false);
  const visible = hovered || menuOpen;
  return (
    <span
      data-part="row-tail"
      style={{ position: 'relative', flexShrink: 0, width: 56, height: 22, marginInlineStart: 4 }}
    >
      <span
        data-part="relative-time"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          opacity: visible ? 0 : 1,
          pointerEvents: 'none',
          transition: 'opacity 120ms',
        }}
      >
        <Text fontSize={10.5} style={{ color: token.colorTextQuaternary, whiteSpace: 'nowrap' }}>
          {time}
        </Text>
      </span>
      <span
        data-part="row-menu"
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? 'auto' : 'none',
          transition: 'opacity 120ms',
        }}
      >
        <Dropdown
          menu={{ items, onClick: onMenuClick }}
          trigger={['click']}
          onOpenChange={setMenuOpen}
        >
          <ActionIcon
            icon={Ellipsis}
            size="small"
            title="更多操作"
            onClick={(event) => event.stopPropagation()}
          />
        </Dropdown>
      </span>
    </span>
  );
}

/* --------------------------------------------------------------------- rows */

/**
 * Shared chrome of a session row: the ~40px clickable surface, the active bar and
 * the hover fill. Keeps the two row kinds visually identical apart from their
 * leading slot and text weight. `tail` is a render prop because the trailing slot
 * swaps the relative time for the overflow menu exactly while the row is hovered.
 */
function RowSurface({
  kind,
  active,
  title,
  onClick,
  children,
  attributes,
  tail,
}: {
  kind: 'live' | 'stored';
  active: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
  attributes?: Record<string, string>;
  tail: (hovered: boolean) => ReactNode;
}) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      data-row={kind}
      data-active={active ? 'true' : 'false'}
      aria-current={active ? 'true' : undefined}
      title={title}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: ROW_HEIGHT,
        paddingInlineStart: 26,
        paddingInlineEnd: 6,
        boxSizing: 'border-box',
        borderRadius: token.borderRadius,
        cursor: 'pointer',
        background: active
          ? token.colorFillSecondary
          : hovered
            ? token.colorFillTertiary
            : 'transparent',
      }}
      {...(attributes ?? {})}
    >
      <span
        aria-hidden
        data-part="active-bar"
        style={{
          position: 'absolute',
          left: 0,
          top: 10,
          bottom: 10,
          width: 3,
          borderRadius: 2,
          background: token.colorPrimary,
          opacity: active ? 1 : 0,
        }}
      />
      {children}
      {tail(hovered)}
    </div>
  );
}

function LiveRow({
  session,
  title,
  active,
  onSwitch,
  onRename,
  onKill,
  onCopyId,
}: {
  session: SessionSummary;
  title: string;
  active: boolean;
  onSwitch: (id: string) => void;
  onRename: (session: SessionSummary, title: string) => void;
  onKill: (session: SessionSummary, title: string) => void;
  onCopyId: (session: SessionSummary) => void;
}) {
  const { token } = theme.useToken();

  const items: MenuProps['items'] = [
    { key: 'rename', label: '重命名', icon: <Icon icon={Pencil} size={13} /> },
    { key: 'copy-id', label: '复制会话 ID', icon: <Icon icon={Copy} size={13} /> },
    { type: 'divider' },
    { key: 'kill', label: '结束会话', danger: true, icon: <Icon icon={Trash2} size={13} /> },
  ];

  const handleMenuClick: NonNullable<MenuProps['onClick']> = ({ key, domEvent }) => {
    // The popup is portalled for layout but still bubbles through the React tree,
    // and the row itself switches sessions — so stop the event here.
    domEvent.stopPropagation();
    if (key === 'rename') onRename(session, title);
    else if (key === 'kill') onKill(session, title);
    else if (key === 'copy-id') onCopyId(session);
  };

  return (
    <RowSurface
      kind="live"
      active={active}
      title={title}
      onClick={() => onSwitch(session.id)}
      attributes={{ 'data-session-id': session.id }}
      tail={(hovered) => (
        <RowTail
          time={formatRelativeTime(session.createdAt)}
          hovered={hovered}
          items={items}
          onMenuClick={handleMenuClick}
        />
      )}
    >
      <Tooltip title={session.streaming ? '正在执行' : session.alive ? '空闲' : '已结束'}>
        <span
          aria-hidden
          data-part="status-dot"
          data-streaming={session.streaming ? 'true' : 'false'}
          style={{
            position: 'relative',
            flexShrink: 0,
            width: 8,
            height: 8,
            marginInline: (LEAD_SLOT - 8) / 2,
            opacity: session.alive ? 1 : 0.45,
          }}
        >
          {session.streaming && (
            <span
              data-part="status-pulse"
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                background: token.colorPrimary,
                animation: 'pi-workspace-tree-pulse 1.6s ease-out infinite',
              }}
            />
          )}
          <span
            style={{
              position: 'absolute',
              inset: 0,
              boxSizing: 'border-box',
              borderRadius: '50%',
              border: `1px solid ${session.streaming ? token.colorPrimary : token.colorTextQuaternary}`,
              background: session.streaming ? token.colorPrimary : 'transparent',
            }}
          />
        </span>
      </Tooltip>
      <Text
        fontSize={12.5}
        ellipsis={{ tooltip: title }}
        style={{ flex: 1, minWidth: 0, color: token.colorText }}
      >
        {title}
      </Text>
    </RowSurface>
  );
}

function StoredRow({
  session,
  title,
  onResume,
  onDelete,
}: {
  session: StoredSession;
  title: string;
  onResume: (session: StoredSession) => void;
  onDelete: (session: StoredSession) => void;
}) {
  const { token } = theme.useToken();

  const relative = formatRelativeTime(new Date(session.startedAt).getTime());
  const time = relative.length > 0 ? relative : session.startedAt.slice(0, 10);

  const items: MenuProps['items'] = [
    { key: 'resume', label: '恢复会话', icon: <Icon icon={RotateCcw} size={13} /> },
    { type: 'divider' },
    { key: 'delete', label: '从磁盘删除', danger: true, icon: <Icon icon={Trash2} size={13} /> },
  ];

  const handleMenuClick: NonNullable<MenuProps['onClick']> = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'resume') onResume(session);
    else if (key === 'delete') onDelete(session);
  };

  return (
    <RowSurface
      kind="stored"
      active={false}
      title={title}
      onClick={() => onResume(session)}
      attributes={{ 'data-session-path': session.path }}
      tail={(hovered) => (
        <RowTail time={time} hovered={hovered} items={items} onMenuClick={handleMenuClick} />
      )}
    >
      <span
        data-part="history-icon"
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          justifyContent: 'center',
          width: LEAD_SLOT,
          color: token.colorTextQuaternary,
        }}
      >
        <Icon icon={History} size={12} />
      </span>
      <Text
        fontSize={12}
        ellipsis={{ tooltip: session.preview ?? title }}
        style={{ flex: 1, minWidth: 0, color: token.colorTextSecondary }}
      >
        {title}
      </Text>
    </RowSurface>
  );
}

/* ------------------------------------------------------------------- groups */

function WorkspaceHeader({
  group,
  expanded,
  count,
  onToggle,
  onPickWorkspace,
  onCreateSession,
  onSetDefault,
  onForgetWorkspace,
}: {
  group: WorkspaceGroup;
  expanded: boolean;
  count: number;
  onToggle: () => void;
  onPickWorkspace: (path: string) => void;
  onCreateSession: (path: string) => void;
  onSetDefault: (path: string) => void;
  onForgetWorkspace: (path: string) => void;
}) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const items: MenuProps['items'] = [
    {
      key: 'current',
      label: '设为当前工作区',
      icon: <Icon icon={FolderOpen} size={13} />,
      disabled: group.isCurrent,
    },
    {
      key: 'default',
      label: '设为默认工作区',
      icon: <Icon icon={Star} size={13} />,
      disabled: group.isDefault,
    },
    { type: 'divider' },
    { key: 'forget', label: '从列表移除', danger: true, icon: <Icon icon={Trash2} size={13} /> },
  ];

  const handleMenuClick: NonNullable<MenuProps['onClick']> = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'current') onPickWorkspace(group.path);
    else if (key === 'default') onSetDefault(group.path);
    else if (key === 'forget') onForgetWorkspace(group.path);
  };

  const revealActions = hovered || menuOpen;
  const showChevron = revealActions || expanded;

  return (
    <div
      role="button"
      tabIndex={0}
      data-row="workspace"
      data-path={group.path}
      data-current={group.isCurrent ? 'true' : 'false'}
      data-default={group.isDefault ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      aria-expanded={expanded}
      title={group.path}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: WORKSPACE_ROW_HEIGHT,
        paddingInlineStart: 6,
        paddingInlineEnd: 4,
        boxSizing: 'border-box',
        borderRadius: token.borderRadius,
        cursor: 'pointer',
        background: hovered ? token.colorFillTertiary : 'transparent',
      }}
    >
      <span
        aria-hidden
        data-part="chevron"
        data-visible={showChevron ? 'true' : 'false'}
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          justifyContent: 'center',
          width: 16,
          color: token.colorTextTertiary,
          opacity: showChevron ? 1 : 0,
          transition: 'opacity 120ms',
        }}
      >
        <Icon icon={expanded ? ChevronDown : ChevronRight} size={13} />
      </span>
      <Icon
        data-part="workspace-folder"
        icon={expanded ? FolderOpen : Folder}
        size={14}
        color={group.isCurrent ? token.colorPrimary : token.colorTextTertiary}
        style={{ flexShrink: 0 }}
      />
      <Flexbox horizontal align="center" gap={6} style={{ flex: 1, minWidth: 0 }}>
        <Text
          fontSize={12.5}
          weight={600}
          ellipsis={{ tooltip: group.path }}
          style={{
            minWidth: 0,
            color: group.isCurrent ? token.colorText : token.colorTextSecondary,
            whiteSpace: 'nowrap',
          }}
        >
          {group.title}
        </Text>
        {group.isDefault && (
          <Tag
            data-part="default-tag"
            color="gold"
            variant="filled"
            icon={<Star size={10} />}
            style={{ flexShrink: 0, marginInlineEnd: 0, fontSize: 10.5, lineHeight: '16px' }}
          >
            默认
          </Tag>
        )}
        {count > 0 && <CountBadge count={count} muted={!group.isCurrent} />}
      </Flexbox>
      <Tooltip title="在此工作区新建会话">
        <ActionIcon
          data-part="new-session"
          icon={Plus}
          size="small"
          title="在此工作区新建会话"
          onClick={(event) => {
            event.stopPropagation();
            onCreateSession(group.path);
          }}
          style={{
            flexShrink: 0,
            opacity: revealActions ? 1 : 0,
            pointerEvents: revealActions ? 'auto' : 'none',
            transition: 'opacity 120ms',
          }}
        />
      </Tooltip>
      <span
        data-part="workspace-menu"
        style={{
          flexShrink: 0,
          opacity: revealActions ? 1 : 0,
          pointerEvents: revealActions ? 'auto' : 'none',
          transition: 'opacity 120ms',
        }}
      >
        <Dropdown
          menu={{ items, onClick: handleMenuClick }}
          trigger={['click']}
          onOpenChange={setMenuOpen}
        >
          <ActionIcon
            icon={Ellipsis}
            size="small"
            title="更多操作"
            onClick={(event) => event.stopPropagation()}
          />
        </Dropdown>
      </span>
    </div>
  );
}

/** 「展开其余 N 条」 / 「收起」 — the per-workspace overflow toggle. */
function OverflowToggle({
  hiddenCount,
  expanded,
  onToggle,
}: {
  hiddenCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  const label = expanded ? '收起' : `展开其余 ${hiddenCount} 条`;
  return (
    <div
      role="button"
      tabIndex={0}
      data-part="group-toggle"
      data-expanded={expanded ? 'true' : 'false'}
      data-hidden-count={hiddenCount}
      title={label}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        paddingInlineStart: 6,
        paddingInlineEnd: 8,
        boxSizing: 'border-box',
        borderRadius: token.borderRadius,
        cursor: 'pointer',
        background: hovered ? token.colorFillTertiary : 'transparent',
      }}
    >
      <span
        aria-hidden
        style={{ flexShrink: 0, display: 'inline-flex', justifyContent: 'center', width: 16 }}
      >
        <Icon icon={expanded ? ChevronUp : ChevronDown} size={12} color={token.colorTextQuaternary} />
      </span>
      <Text fontSize={11} style={{ color: token.colorTextTertiary }}>
        {label}
      </Text>
    </div>
  );
}

/* ---------------------------------------------------------------- component */

export interface WorkspaceGroup {
  /** the workspace's absolute path — its identity */
  path: string;
  /** display title (already abbreviated, e.g. ~/code/foo) */
  title: string;
  isCurrent: boolean;
  isDefault: boolean;
  /** live sessions in this workspace, newest first */
  sessions: SessionSummary[];
  /** persisted sessions in this workspace, newest first */
  stored: StoredSession[];
}

export interface WorkspaceTreeProps {
  groups: WorkspaceGroup[];
  activeId: string | null;
  home?: string;
  storedLoading?: boolean;
  onPickWorkspace: (path: string) => void;
  onCreateSession: (path: string) => void;
  onSetDefault: (path: string) => void;
  onForgetWorkspace: (path: string) => void;
  onSwitch: (id: string) => void;
  onKill: (id: string) => void;
  onResume: (session: StoredSession) => void;
  onDeleteStored: (session: StoredSession) => void;
  onRename: (id: string, name: string) => void;
}

export function WorkspaceTree({
  groups,
  activeId,
  home,
  storedLoading,
  onPickWorkspace,
  onCreateSession,
  onSetDefault,
  onForgetWorkspace,
  onSwitch,
  onKill,
  onResume,
  onDeleteStored,
  onRename,
}: WorkspaceTreeProps) {
  const { token } = theme.useToken();
  const { confirm, success } = useAntdFeedback();
  const [query, setQuery] = useState<string>('');
  /** path → explicit expansion, seeded from `isCurrent` for untouched workspaces. */
  const [expansion, setExpansion] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  /** id → name the user just confirmed, echoed by pi on the next poll. */
  const [pendingNames, setPendingNames] = useState<Map<string, string>>(() => new Map());
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const liveById = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const group of groups) {
      for (const session of group.sessions) map.set(session.id, session);
    }
    return map;
  }, [groups]);

  /** Drop an optimistic name once pi echoes it back, or once the session is gone. */
  useEffect(() => {
    setPendingNames((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const [id, name] of next) {
        const live = liveById.get(id);
        if (live === undefined || live.sessionName === name) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [liveById]);

  const titleOf = useCallback(
    (session: SessionSummary): string =>
      pendingNames.get(session.id) ??
      session.sessionName ??
      shortenCwd(session.cwd, home),
    [home, pendingNames],
  );

  const toggleGroup = useCallback(
    (group: WorkspaceGroup) => {
      setExpansion((prev) => {
        const current = prev.get(group.path) ?? group.isCurrent;
        return new Map(prev).set(group.path, !current);
      });
    },
    [],
  );

  const openRename = useCallback((session: SessionSummary, title: string) => {
    setRenameTarget({ id: session.id, title });
    setRenameValue(title);
  }, []);

  const submitRename = useCallback(() => {
    const target = renameTarget;
    if (target === null) return;
    const name = renameValue.trim();
    setRenameTarget(null);
    if (name.length === 0 || name === target.title) return;
    // Show it right away: the parent's poll only picks the new name up later.
    setPendingNames((prev) => new Map(prev).set(target.id, name));
    onRename(target.id, name);
  }, [onRename, renameTarget, renameValue]);

  const requestKill = useCallback(
    (session: SessionSummary, title: string) => {
      confirm({
        title: '结束会话',
        content: `确定要结束「${truncate(title, 40)}」吗？该会话的 pi 进程会立即退出。`,
        okText: '结束会话',
        okType: 'danger',
        cancelText: '取消',
        centered: true,
        onOk: () => onKill(session.id),
      });
    },
    [confirm, onKill],
  );

  const requestDeleteStored = useCallback(
    (session: StoredSession) => {
      confirm({
        title: '从磁盘删除会话',
        content: `确定要删除「${truncate(storedTitleOf(session), 40)}」吗？该会话的转录文件会从磁盘永久删除，无法恢复。`,
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        centered: true,
        onOk: () => onDeleteStored(session),
      });
    },
    [confirm, onDeleteStored],
  );

  const copyId = useCallback(
    (session: SessionSummary) => {
      void navigator.clipboard?.writeText(session.id).catch(() => {});
      success?.('已复制会话 ID');
    },
    [success],
  );

  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;

  /**
   * Groups in the order given, each with its search-filtered rows. While a query is
   * active a workspace that ends up with nothing to show is dropped entirely;
   * without one every workspace keeps its row, even an empty one.
   */
  const sections = useMemo(
    () =>
      groups.map((group) => {
        const sessions = searching
          ? group.sessions.filter((session) =>
              matchesQuery(needle, [
                titleOf(session),
                session.provider,
                session.model,
                session.cwd,
              ]),
            )
          : group.sessions;
        const stored = searching
          ? group.stored.filter((session) =>
              matchesQuery(needle, [session.preview, storedTitleOf(session), session.cwd]),
            )
          : group.stored;
        return { group, sessions, stored, matched: sessions.length + stored.length };
      }),
    [groups, needle, searching, titleOf],
  );

  const matchCount = useMemo(
    () => sections.reduce((total, section) => total + section.matched, 0),
    [sections],
  );
  const totalCount = useMemo(
    () =>
      groups.reduce((total, group) => total + group.sessions.length + group.stored.length, 0),
    [groups],
  );

  const nothingAtAll = totalCount === 0;
  const nothingMatched = !nothingAtAll && matchCount === 0;
  const visibleSections = searching
    ? sections.filter((section) => section.matched > 0)
    : sections;

  return (
    <Flexbox
      data-part="workspace-tree"
      data-stored-loading={storedLoading === true ? 'true' : 'false'}
      style={{ flex: 1, minHeight: 0, height: '100%' }}
    >
      <style>{PULSE_STYLE}</style>

      <Flexbox paddingInline={12} paddingBlock={6} gap={6} style={{ flexShrink: 0 }}>
        <Flexbox horizontal align="center" gap={6}>
          <Flexbox flex={1} allowShrink>
            <Input
              allowClear
              size="small"
              value={query}
              placeholder="搜索会话"
              prefix={<Icon icon={Search} size={13} color={token.colorTextQuaternary} />}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Flexbox>
          {searching && (
            <span data-part="match-count" title={`匹配 ${matchCount} 条会话`}>
              <CountBadge count={matchCount} />
            </span>
          )}
        </Flexbox>
      </Flexbox>

      <div
        data-part="scroll-area"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          paddingInline: 12,
          paddingBottom: 12,
        }}
      >
        {nothingAtAll || nothingMatched ? (
          <EmptyState text={nothingMatched ? '没有匹配的会话' : '暂无会话'} />
        ) : (
          <Flexbox gap={2}>
            {visibleSections.map((section) => (
              <WorkspaceSection
                key={section.group.path}
                group={section.group}
                sessions={section.sessions}
                stored={section.stored}
                matched={section.matched}
                expanded={expansion.get(section.group.path) ?? section.group.isCurrent}
                activeId={activeId}
                titleOf={titleOf}
                onToggle={toggleGroup}
                onPickWorkspace={onPickWorkspace}
                onCreateSession={onCreateSession}
                onSetDefault={onSetDefault}
                onForgetWorkspace={onForgetWorkspace}
                onSwitch={onSwitch}
                onRename={openRename}
                onKill={requestKill}
                onCopyId={copyId}
                onResume={onResume}
                onDeleteStored={requestDeleteStored}
              />
            ))}
          </Flexbox>
        )}
      </div>

      <Modal
        open={renameTarget !== null}
        title="重命名会话"
        okText="确定"
        cancelText="取消"
        width={360}
        centered
        destroyOnHidden
        okButtonProps={{ disabled: renameValue.trim().length === 0 }}
        onCancel={() => setRenameTarget(null)}
        onOk={submitRename}
      >
        <Input
          autoFocus
          maxLength={80}
          value={renameValue}
          placeholder="输入会话名称"
          onChange={(event) => setRenameValue(event.target.value)}
          onPressEnter={submitRename}
        />
      </Modal>
    </Flexbox>
  );
}

/**
 * One workspace and its rows: the header plus, while expanded, the live sessions,
 * the stored transcripts and the overflow toggle. The "show all rows" flag is local
 * to the section so collapsing a workspace also forgets it.
 */
function WorkspaceSection({
  group,
  sessions,
  stored,
  matched,
  expanded,
  activeId,
  titleOf,
  onToggle,
  onPickWorkspace,
  onCreateSession,
  onSetDefault,
  onForgetWorkspace,
  onSwitch,
  onRename,
  onKill,
  onCopyId,
  onResume,
  onDeleteStored,
}: {
  group: WorkspaceGroup;
  sessions: SessionSummary[];
  stored: StoredSession[];
  matched: number;
  expanded: boolean;
  activeId: string | null;
  titleOf: (session: SessionSummary) => string;
  onToggle: (group: WorkspaceGroup) => void;
  onPickWorkspace: (path: string) => void;
  onCreateSession: (path: string) => void;
  onSetDefault: (path: string) => void;
  onForgetWorkspace: (path: string) => void;
  onSwitch: (id: string) => void;
  onRename: (session: SessionSummary, title: string) => void;
  onKill: (session: SessionSummary, title: string) => void;
  onCopyId: (session: SessionSummary) => void;
  onResume: (session: StoredSession) => void;
  onDeleteStored: (session: StoredSession) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const rows = sessions.length + stored.length;
  const overflow = rows > MAX_VISIBLE_ROWS;
  const hiddenCount = Math.max(0, rows - MAX_VISIBLE_ROWS);
  const visibleLive = showAll ? sessions : sessions.slice(0, MAX_VISIBLE_ROWS);
  const visibleStored = showAll
    ? stored
    : stored.slice(0, Math.max(0, MAX_VISIBLE_ROWS - visibleLive.length));

  return (
    <div
      data-part="workspace-group"
      data-path={group.path}
      data-current={group.isCurrent ? 'true' : 'false'}
      data-default={group.isDefault ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      data-rows={rows}
    >
      <WorkspaceHeader
        group={group}
        expanded={expanded}
        count={matched}
        onToggle={() => onToggle(group)}
        onPickWorkspace={onPickWorkspace}
        onCreateSession={onCreateSession}
        onSetDefault={onSetDefault}
        onForgetWorkspace={onForgetWorkspace}
      />

      {expanded && (
        <Flexbox data-part="group-rows" gap={0} style={{ paddingBottom: 4 }}>
          {visibleLive.map((session) => (
            <LiveRow
              key={session.id}
              session={session}
              title={titleOf(session)}
              active={session.id === activeId}
              onSwitch={onSwitch}
              onRename={onRename}
              onKill={onKill}
              onCopyId={onCopyId}
            />
          ))}
          {visibleStored.map((session) => (
            <StoredRow
              key={session.path}
              session={session}
              title={storedTitleOf(session)}
              onResume={onResume}
              onDelete={onDeleteStored}
            />
          ))}
          {overflow && (
            <OverflowToggle
              hiddenCount={hiddenCount}
              expanded={showAll}
              onToggle={() => setShowAll((prev) => !prev)}
            />
          )}
        </Flexbox>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ asserts */

/**
 * Usage assert: the sidebar renders `<WorkspaceTree {...props} />` with exactly the
 * props below, so the assignment fails `tsc` the moment the component stops
 * accepting `WorkspaceTreeProps`.
 */
type _Assert = WorkspaceTreeProps;
const _assertComponent: FC<_Assert> = WorkspaceTree;
void _assertComponent;

/** Usage assert: a group is built from these six fields and nothing else. */
const _assertGroupShape = (
  group: WorkspaceGroup,
): [string, string, boolean, boolean, SessionSummary[], StoredSession[]] => [
  group.path,
  group.title,
  group.isCurrent,
  group.isDefault,
  group.sessions,
  group.stored,
];
void _assertGroupShape;
