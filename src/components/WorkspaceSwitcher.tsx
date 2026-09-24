/**
 * The workspace (working directory) chip in the composer's context bar.
 * LobeChat has no direct analogue — this is pi-specific, since pi always
 * operates inside one directory.
 *
 * It is a pill on purpose: a full-width box above the composer claimed the width
 * of the surface that actually carries the decision (the message), and it read
 * as a form field rather than as one chip among the composer's controls. The
 * menu is the vendored `Menu` primitive — the app's own list language, the same
 * one the sidebar's workspace rows use: one folder row per workspace, the
 * current one carrying the trailing check, and the add action pinned under a
 * hairline in the footer.
 */
import { Text } from '@lobehub/ui';
import { theme } from 'antd';
import { ChevronDown, Folder } from 'lucide-react';
import { useState } from 'react';

import { IconFolderClose16, IconPlusOutline16, Menu } from '../ui/primitives/index.ts';
import type { MenuEntry } from '../ui/primitives/index.ts';
import { workspaceLabel } from './sidebar/tree';

/** Row id of the footer's add action — never a path, so it cannot collide. */
const ADD_WORKSPACE = '::add-workspace';

/** `/Users/x/work` → `~/work` when it lives under the reported home dir. */
function shortPath(path: string, home: string | undefined): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

export interface WorkspaceSwitcherProps {
  cwd: string;
  /** The same visible workspace paths shown in the sidebar. */
  workspaces: string[];
  home?: string;
  disabled?: boolean;
  onPick: (path: string) => void;
  /** Open the OS directory chooser — the one way a new workspace enters the list. */
  onBrowse: () => void;
}

export function WorkspaceSwitcher({
  cwd,
  workspaces,
  home,
  disabled,
  onPick,
  onBrowse,
}: WorkspaceSwitcherProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  const candidates = Array.from(new Set([cwd, ...workspaces])).filter(Boolean);

  const items: MenuEntry[] = candidates.map((path) => ({
    id: path,
    // The row is the folder's name and the tooltip its path: two workspaces can
    // share a basename, and a menu is too narrow for both to be spelled out.
    label: <span title={shortPath(path, home)}>{workspaceLabel(path) || path}</span>,
    icon: <IconFolderClose16 />,
  }));
  const footer: MenuEntry[] = [{
    id: ADD_WORKSPACE,
    label: '添加工作区…',
    icon: <IconPlusOutline16 />,
    disabled: disabled === true,
  }];

  return (
    <Menu
      open={open && disabled !== true}
      anchor={(
        <button
          type="button"
          disabled={disabled}
          aria-label={`当前工作区：${workspaceLabel(cwd) || '未选择'}`}
          onMouseEnter={() => { setHovered(true); }}
          onMouseLeave={() => { setHovered(false); }}
          onClick={() => { setOpen((prev) => !prev); }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 24,
            maxWidth: 220,
            paddingInline: 8,
            borderStyle: 'none',
            borderRadius: 999,
            background: open || hovered ? token.colorFillTertiary : 'transparent',
            color: token.colorTextSecondary,
            fontFamily: 'inherit',
            fontSize: 12,
            cursor: disabled === true ? 'not-allowed' : 'pointer',
            opacity: disabled === true ? 0.5 : 1,
            transition: 'background 0.15s ease',
          }}
        >
          <Folder size={13} style={{ flexShrink: 0 }} />
          <Text
            as="span"
            ellipsis
            fontSize={12}
            style={{ minWidth: 0, maxWidth: 170, color: 'inherit' }}
            title={cwd}
          >
            {workspaceLabel(cwd) || '未选择'}
          </Text>
          <ChevronDown size={13} style={{ flexShrink: 0, opacity: 0.65 }} />
        </button>
      )}
      items={items}
      footer={footer}
      selectedId={cwd}
      // The chip sits in the composer, so the list opens upward.
      side="top"
      portal
      closeOnPointerLeave
      onSelect={(id) => {
        setOpen(false);
        if (id === ADD_WORKSPACE) onBrowse();
        else onPick(id);
      }}
      onClose={() => { setOpen(false); }}
    />
  );
}
