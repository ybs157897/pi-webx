import { Flexbox, Icon, Text } from '@lobehub/ui';
import { Dropdown, theme } from 'antd';
import type { MenuProps } from 'antd';
import { ChevronDown, Folder, FolderOpen, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';

function shortPath(path: string, home: string | undefined): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

export interface WorkspaceSwitcherProps {
  cwd: string;
  /** candidates offered as one-click picks (server-provided + user history) */
  recent: string[];
  home?: string;
  defaultCwd?: string | null;
  /** stored-session count per workspace path, when the parent has it */
  counts?: Record<string, number>;
  disabled?: boolean;
  onPick: (path: string) => void;
  onBrowse: () => void;
  onSetDefault: (path: string) => void;
  /** removes a path from the saved list (never deletes anything on disk) */
  onForget?: (path: string) => void;
}

/** Positive, finite counts only — anything else renders no badge at all. */
function sessionCount(counts: Record<string, number> | undefined, path: string): number {
  const value = counts?.[path];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The workspace (working directory) selector. LobeChat has no direct analogue —
 * this is pi-specific, since pi always operates inside one directory.
 */
export function WorkspaceSwitcher({
  cwd,
  recent,
  home,
  defaultCwd,
  counts,
  disabled,
  onPick,
  onBrowse,
  onSetDefault,
  onForget,
}: WorkspaceSwitcherProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);

  const candidates = Array.from(new Set([cwd, ...recent])).filter(Boolean).slice(0, 8);
  const cwdCount = sessionCount(counts, cwd);

  const items: MenuProps['items'] = [
    ...candidates.map((path) => {
      const count = sessionCount(counts, path);
      return {
        key: path,
        label: (
          <Flexbox horizontal align="center" gap={8} style={{ minWidth: 0 }}>
            <Icon icon={Folder} size={13} />
            <Text fontSize={12} ellipsis style={{ maxWidth: 220 }}>
              {shortPath(path, home)}
            </Text>
            {path === cwd && (
              <>
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: token.colorPrimary,
                  }}
                />
                <Text fontSize={10.5} style={{ color: token.colorPrimary, flexShrink: 0 }}>
                  当前
                </Text>
              </>
            )}
            {defaultCwd === path && (
              <Icon icon={Star} size={12} style={{ color: token.colorWarning, flexShrink: 0 }} />
            )}
          </Flexbox>
        ),
        // Right-aligned by antd (`.ant-dropdown-menu-item-extra`), secondary style.
        extra:
          count > 0 ? (
            <Text fontSize={11} style={{ color: token.colorTextTertiary, whiteSpace: 'nowrap' }}>
              {count} 会话
            </Text>
          ) : undefined,
        onClick: () => {
          setOpen(false);
          onPick(path);
        },
      };
    }),
    { type: 'divider' },
    {
      key: 'browse',
      label: (
        <Flexbox horizontal align="center" gap={8}>
          <Icon icon={FolderOpen} size={13} />
          <Text fontSize={12}>浏览目录…</Text>
        </Flexbox>
      ),
      onClick: () => {
        setOpen(false);
        onBrowse();
      },
    },
    ...(cwd
      ? [
          {
            key: 'default',
            label: (
              <Flexbox horizontal align="center" gap={8}>
                <Icon icon={Star} size={13} />
                <Text fontSize={12}>设为默认工作区</Text>
              </Flexbox>
            ),
            onClick: () => {
              setOpen(false);
              onSetDefault(cwd);
            },
          },
        ]
      : []),
    ...(onForget !== undefined && cwd
      ? [
          {
            key: 'forget',
            label: (
              <Flexbox horizontal align="center" gap={8}>
                <Icon icon={Trash2} size={13} />
                <Text fontSize={12}>移出列表（当前工作区）</Text>
              </Flexbox>
            ),
            onClick: () => {
              setOpen(false);
              onForget(cwd);
            },
          },
        ]
      : []),
  ];

  return (
    <Dropdown
      trigger={['click']}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
      menu={{ items }}
    >
      <button
        type="button"
        disabled={disabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '6px 8px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadius,
          background: token.colorBgContainer,
          color: token.colorText,
        }}
      >
        <Folder size={13} style={{ color: token.colorTextTertiary, flexShrink: 0 }} />
        <Flexbox gap={0} style={{ minWidth: 0, flex: 1 }}>
          <Text fontSize={11} style={{ color: token.colorTextQuaternary }}>
            工作区
          </Text>
          <Flexbox horizontal align="center" gap={4} style={{ minWidth: 0 }}>
            <Text fontSize={12} ellipsis style={{ minWidth: 0 }} title={cwd}>
              {shortPath(cwd, home) || '未选择'}
            </Text>
            {cwdCount > 0 && (
              <Text
                fontSize={10.5}
                style={{ color: token.colorTextQuaternary, flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                · {cwdCount} 会话
              </Text>
            )}
          </Flexbox>
        </Flexbox>
        <Icon icon={ChevronDown} size={13} style={{ color: token.colorTextQuaternary, flexShrink: 0 }} />
      </button>
    </Dropdown>
  );
}

export { shortPath };
