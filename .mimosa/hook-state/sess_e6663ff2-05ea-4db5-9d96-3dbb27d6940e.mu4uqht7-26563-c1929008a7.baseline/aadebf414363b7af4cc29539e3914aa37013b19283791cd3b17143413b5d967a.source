/**
 * Unified session list (V2): one search box over one list — the live in-process pi
 * sessions, then the persisted transcripts found on disk under 今天 / 昨天 / 近 7 天 /
 * 更早 date buckets — replacing the two-section layout that read as two competing
 * inventories.
 *
 * Self-contained and purely presentational: every datum arrives through props, the
 * only local state is the query, the optimistic rename names and the open row menus,
 * and nothing is fetched. Searching is a local case-insensitive substring filter over
 * the displayed title, provider/model, cwd and the stored preview.
 */

import { ActionIcon, Flexbox, Icon, Text, Tooltip } from '@lobehub/ui';
import { App, Dropdown, Empty, Input, Modal, theme } from 'antd';
import type { MenuProps, ModalFuncProps } from 'antd';
import { Copy, Ellipsis, Pencil, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FC, ReactNode } from 'react';

import { formatRelativeTime, truncate } from '../lib/format';
import type { SessionSummary, StoredSession } from '../shared/protocol';

/** Dense rows so a long history stays scannable. */
const ROW_HEIGHT = 40;

/**
 * Pulsing halo for the streaming dot. Inlined because the component must stay
 * self-contained; a duplicated `<style>` tag per instance is harmless. The reduced
 * motion clause keeps the dot readable for users who opt out of animation.
 */
const PULSE_STYLE = `@keyframes pi-session-list-v2-pulse{0%{transform:scale(1);opacity:.55}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}@media (prefers-reduced-motion: reduce){[data-part="status-pulse"]{animation:none !important}}`;

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

/* ---------------------------------------------------------------- date groups */

/** Sub-headers of the stored-session group, most recent bucket first. */
const STORED_BUCKETS = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'week', label: '近 7 天' },
  { key: 'older', label: '更早' },
] as const;

type StoredBucketKey = (typeof STORED_BUCKETS)[number]['key'];

/** Local midnight of the day `daysAgo` days before `now`. */
function startOfLocalDay(now: Date, daysAgo: number): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  midnight.setDate(midnight.getDate() - daysAgo);
  return midnight.getTime();
}

/**
 * Calendar bucket of a session start time. 今天 / 昨天 / 近 7 天 cover exactly the
 * last seven calendar days — today, the previous day, then the six days before
 * that — so every bucket is disjoint; anything older (or unparseable) is 更早.
 */
function storedBucketOf(startedAtMs: number, now: Date): StoredBucketKey {
  if (Number.isFinite(startedAtMs)) {
    if (startedAtMs >= startOfLocalDay(now, 0)) return 'today';
    if (startedAtMs >= startOfLocalDay(now, 1)) return 'yesterday';
    if (startedAtMs >= startOfLocalDay(now, 6)) return 'week';
  }
  return 'older';
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
      fontSize={11}
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

function SectionHeader({
  section,
  label,
  count,
  action,
}: {
  section: 'live' | 'stored';
  label: string;
  count: number;
  action?: ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <Flexbox
      horizontal
      align="center"
      justify="space-between"
      gap={6}
      data-section={section}
      data-part="section-header"
      style={{ paddingBlock: 6, paddingInline: 4, flexShrink: 0 }}
    >
      <Flexbox horizontal align="center" gap={6}>
        <Text
          fontSize={11}
          weight={600}
          style={{ color: token.colorTextTertiary, letterSpacing: 0.4 }}
        >
          {label}
        </Text>
        <CountBadge count={count} muted={count === 0} />
      </Flexbox>
      {action}
    </Flexbox>
  );
}

/** Lighter than `SectionHeader`: date buckets are already nested one level deep. */
function BucketHeader({ bucket, label, count }: { bucket: StoredBucketKey; label: string; count: number }) {
  const { token } = theme.useToken();
  return (
    <Flexbox
      horizontal
      align="center"
      gap={6}
      data-bucket={bucket}
      data-part="bucket-header"
      style={{ paddingBlock: 4, paddingInline: 4, flexShrink: 0 }}
    >
      <Text
        fontSize={10.5}
        weight={600}
        style={{ color: token.colorTextQuaternary, letterSpacing: 0.4 }}
      >
        {label}
      </Text>
      <CountBadge count={count} muted />
    </Flexbox>
  );
}

function EmptyHint({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <Text fontSize={11.5} style={{ color: token.colorTextQuaternary, padding: '6px 8px' }}>
      {text}
    </Text>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <Flexbox align="center" justify="center" data-part="empty-state" style={{ paddingBlock: 32 }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />
    </Flexbox>
  );
}

/* --------------------------------------------------------------------- rows */

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
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const subtitle = [session.provider, session.model]
    .filter((part): part is string => isNonEmptyString(part))
    .join(' · ');

  const items: MenuProps['items'] = [
    { key: 'rename', label: '重命名', icon: <Icon icon={Pencil} size={13} /> },
    { key: 'copy-id', label: '复制会话 ID', icon: <Icon icon={Copy} size={13} /> },
    { type: 'divider' },
    { key: 'kill', label: '结束会话', danger: true, icon: <Icon icon={Trash2} size={13} /> },
  ];

  const handleMenuClick: NonNullable<MenuProps['onClick']> = ({ key }) => {
    if (key === 'rename') onRename(session, title);
    else if (key === 'kill') onKill(session, title);
    else onCopyId(session);
  };

  const showMenu = hovered || menuOpen || active;

  return (
    <div
      role="button"
      tabIndex={0}
      data-row="live"
      data-session-id={session.id}
      data-active={active ? 'true' : 'false'}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSwitch(session.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSwitch(session.id);
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
        paddingInline: 8,
        boxSizing: 'border-box',
        borderRadius: token.borderRadius,
        cursor: 'pointer',
        background: active
          ? token.colorFillSecondary
          : hovered
            ? token.colorFillTertiary
            : 'transparent',
      }}
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
            marginInlineStart: 2,
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
                animation: 'pi-session-list-v2-pulse 1.6s ease-out infinite',
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
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text fontSize={12.5} ellipsis={{ tooltip: title }} style={{ color: token.colorText }}>
          {title}
        </Text>
        {subtitle.length > 0 && (
          <Text fontSize={11} ellipsis style={{ color: token.colorTextQuaternary }}>
            {subtitle}
          </Text>
        )}
      </div>
      <Dropdown
        menu={{ items, onClick: handleMenuClick }}
        trigger={['click']}
        onOpenChange={(open) => setMenuOpen(open)}
      >
        <ActionIcon
          icon={Ellipsis}
          size="small"
          title="更多操作"
          onClick={(event) => event.stopPropagation()}
          style={{ flexShrink: 0, opacity: showMenu ? 1 : 0.55 }}
        />
      </Dropdown>
    </div>
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
  /** omitted when the parent cannot delete persisted transcripts */
  onDelete?: ((session: StoredSession) => void) | undefined;
}) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const relative = formatRelativeTime(new Date(session.startedAt).getTime());
  const subtitle = relative.length > 0 ? relative : session.startedAt.slice(0, 10);

  const deleteItems: NonNullable<MenuProps['items']> =
    onDelete === undefined
      ? []
      : [
          { type: 'divider' },
          {
            key: 'delete',
            label: '从磁盘删除',
            danger: true,
            icon: <Icon icon={Trash2} size={13} />,
          },
        ];

  const items: MenuProps['items'] = [
    { key: 'resume', label: '恢复会话', icon: <Icon icon={RotateCcw} size={13} /> },
    ...deleteItems,
  ];

  const handleMenuClick: NonNullable<MenuProps['onClick']> = ({ key, domEvent }) => {
    // The popup is portalled for layout but still bubbles through the React tree,
    // and the row itself resumes the session — so stop the event here.
    domEvent.stopPropagation();
    if (key === 'resume') onResume(session);
    else if (key === 'delete') onDelete?.(session);
  };

  const showMenu = hovered || menuOpen;

  return (
    <div
      role="button"
      tabIndex={0}
      data-row="stored"
      data-session-path={session.path}
      onClick={() => onResume(session)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onResume(session);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: ROW_HEIGHT,
        // Aligns the title with live rows, which carry an 8px status dot first.
        paddingInlineStart: 24,
        paddingInlineEnd: 8,
        boxSizing: 'border-box',
        borderRadius: token.borderRadius,
        cursor: 'pointer',
        background: showMenu ? token.colorFillTertiary : 'transparent',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          fontSize={12}
          ellipsis={{ tooltip: session.preview ?? title }}
          style={{ color: token.colorTextSecondary }}
        >
          {title}
        </Text>
        <Text fontSize={10.5} style={{ color: token.colorTextQuaternary }}>
          {subtitle}
        </Text>
      </div>
      <Dropdown
        menu={{ items, onClick: handleMenuClick }}
        trigger={['click']}
        onOpenChange={(open) => setMenuOpen(open)}
      >
        <ActionIcon
          icon={Ellipsis}
          size="small"
          title="更多操作"
          onClick={(event) => event.stopPropagation()}
          style={{ flexShrink: 0, opacity: showMenu ? 1 : 0.55 }}
        />
      </Dropdown>
    </div>
  );
}

/* ---------------------------------------------------------------- component */

export interface SessionListV2Props {
  /** live, in-process sessions */
  sessions: SessionSummary[];
  /** persisted sessions on disk, already filtered to the current workspace */
  stored: StoredSession[];
  storedLoading?: boolean;
  activeId: string | null;
  home?: string;
  onSwitch: (id: string) => void;
  onKill: (id: string) => void;
  onResume: (session: StoredSession) => void;
  onDeleteStored: (session: StoredSession) => void;
  /** rename a LIVE session via pi's set_session_name */
  onRename: (id: string, name: string) => void;
  onRefresh: () => void;
}

export function SessionListV2({
  sessions,
  stored,
  storedLoading,
  activeId,
  home,
  onSwitch,
  onKill,
  onResume,
  onDeleteStored,
  onRename,
  onRefresh,
}: SessionListV2Props) {
  const { token } = theme.useToken();
  const { confirm, success } = useAntdFeedback();
  const [query, setQuery] = useState<string>('');
  /** id → name the user just confirmed, echoed by pi on the next poll. */
  const [pendingNames, setPendingNames] = useState<Map<string, string>>(() => new Map());
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /* Drop an optimistic name once pi echoes it back, or once the session is gone. */
  useEffect(() => {
    setPendingNames((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        const live = sessions.find((session) => session.id === id);
        if (live === undefined || live.sessionName === next.get(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const titleOf = useCallback(
    (session: SessionSummary): string =>
      pendingNames.get(session.id) ??
      session.sessionName ??
      shortenCwd(session.cwd, home),
    [home, pendingNames],
  );

  const needle = query.trim().toLowerCase();

  const visibleSessions = useMemo(
    () =>
      sessions.filter((session) =>
        matchesQuery(needle, [titleOf(session), session.provider, session.model, session.cwd]),
      ),
    [needle, sessions, titleOf],
  );

  const visibleStored = useMemo(
    () =>
      stored.filter((session) =>
        matchesQuery(needle, [
          session.preview,
          storedTitleOf(session),
          session.cwd,
        ]),
      ),
    [needle, stored],
  );

  /**
   * Search-filtered stored sessions, split into 今天/昨天/近 7 天/更早 sub-groups with
   * empty buckets omitted. The wall clock is read here rather than in the row
   * renderers; relative labels come from the prop timestamps alone.
   */
  const storedBuckets = useMemo(() => {
    if (visibleStored.length === 0) return [];
    const now = new Date();
    const grouped = new Map<StoredBucketKey, StoredSession[]>();
    for (const session of visibleStored) {
      const key = storedBucketOf(new Date(session.startedAt).getTime(), now);
      const bucket = grouped.get(key);
      if (bucket === undefined) grouped.set(key, [session]);
      else bucket.push(session);
    }
    return STORED_BUCKETS.flatMap(({ key, label }) => {
      const items = grouped.get(key);
      return items === undefined ? [] : [{ key, label, items }];
    });
  }, [visibleStored]);

  const matchCount = visibleSessions.length + visibleStored.length;
  const totalCount = sessions.length + stored.length;

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

  const copyId = useCallback(
    (session: SessionSummary) => {
      void navigator.clipboard?.writeText(session.id).catch(() => {});
      success?.('已复制会话 ID');
    },
    [success],
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
        onOk: () => onDeleteStored?.(session),
      });
    },
    [confirm, onDeleteStored],
  );

  const nothingAtAll = totalCount === 0;
  const nothingMatched = !nothingAtAll && matchCount === 0;
  const canDeleteStored = typeof onDeleteStored === 'function';

  return (
    <Flexbox style={{ height: '100%', minHeight: 0 }}>
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
          {needle.length > 0 && (
            <span data-part="match-count">
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
        <Flexbox gap={2}>
          {visibleSessions.length > 0 && (
            <Flexbox data-part="live-section">
              <SectionHeader section="live" label="运行中" count={visibleSessions.length} />
              {visibleSessions.map((session) => (
                <LiveRow
                  key={session.id}
                  session={session}
                  title={titleOf(session)}
                  active={session.id === activeId}
                  onSwitch={onSwitch}
                  onRename={openRename}
                  onKill={requestKill}
                  onCopyId={copyId}
                />
              ))}
            </Flexbox>
          )}

          <SectionHeader
            section="stored"
            label="历史"
            count={visibleStored.length}
            action={
              <ActionIcon
                data-part="refresh"
                icon={RefreshCw}
                size="small"
                spin={storedLoading === true}
                title="刷新"
                onClick={onRefresh}
              />
            }
          />

          {nothingAtAll || nothingMatched ? (
            <EmptyState text={nothingMatched ? '没有匹配的会话' : '暂无会话'} />
          ) : storedBuckets.length === 0 ? (
            <EmptyHint text={storedLoading === true ? '加载中…' : '暂无可恢复的历史会话'} />
          ) : (
            storedBuckets.map((bucket) => (
              <Flexbox key={bucket.key} data-part="bucket">
                <BucketHeader bucket={bucket.key} label={bucket.label} count={bucket.items.length} />
                {bucket.items.map((session) => (
                  <StoredRow
                    key={session.path}
                    session={session}
                    title={storedTitleOf(session)}
                    onResume={onResume}
                    onDelete={canDeleteStored ? requestDeleteStored : undefined}
                  />
                ))}
              </Flexbox>
            ))
          )}
        </Flexbox>
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

/* ------------------------------------------------------------------ asserts */

/**
 * Usage assert: the sidebar renders `<SessionListV2 {...props} />` with exactly the
 * props below, so the assignment fails `tsc` the moment the component stops
 * accepting `SessionListV2Props`.
 */
type _Assert = SessionListV2Props;
const _assertComponent: FC<_Assert> = SessionListV2;
void _assertComponent;
