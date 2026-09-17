import { ActionIcon, Flexbox, Text, Tooltip } from '@lobehub/ui';
import { theme } from 'antd';
import { Cpu, FolderPlus, LayoutGrid, MessageSquarePlus, Moon, PanelLeft, RefreshCw, Settings2, Sun } from 'lucide-react';
import { useState } from 'react';

import type { ServerConfigResponse, StoredSession } from '../shared/protocol';
import { WorkspaceTree, type WorkspaceGroup } from './WorkspaceTree';

export interface SessionSidebarProps {
  config: ServerConfigResponse | null;
  groups: WorkspaceGroup[];
  storedLoading: boolean;
  activeId: string | null;
  themeMode: 'light' | 'dark';
  connected: boolean;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenModels: () => void;
  onOpenShowcase: () => void;
  onNewSession: () => void;
  onCreateSession: (path: string) => void;
  onPickWorkspace: (path: string) => void;
  onBrowseWorkspace: () => void;
  onSetDefaultWorkspace: (path: string) => void;
  onForgetWorkspace: (path: string) => void;
  onSwitchSession: (id: string) => void;
  onKillSession: (id: string) => void;
  onResumeStored: (session: StoredSession) => void;
  onDeleteStored: (session: StoredSession) => void;
  onRenameSession: (id: string, name: string) => void;
  onRefreshStored: () => void;
}

const RAIL_WIDTH = 56;
const WIDE_WIDTH = 272;

/**
 * deepseek-harness-style navigation rail: brand + collapse, new-session
 * button, then the workspace-grouped session tree, settings at the foot.
 * Collapses to a 56px icon rail; expansion state lives locally.
 */
export function SessionSidebar({
  config,
  groups,
  storedLoading,
  activeId,
  themeMode,
  connected,
  onToggleTheme,
  onOpenSettings,
  onOpenModels,
  onOpenShowcase,
  onNewSession,
  onCreateSession,
  onPickWorkspace,
  onBrowseWorkspace,
  onSetDefaultWorkspace,
  onForgetWorkspace,
  onSwitchSession,
  onKillSession,
  onResumeStored,
  onDeleteStored,
  onRenameSession,
  onRefreshStored,
}: SessionSidebarProps) {
  const { token } = theme.useToken();
  const [collapsed, setCollapsed] = useState(false);
  const wide = !collapsed;

  const currentTitle = groups.find((group) => group.isCurrent)?.title ?? '';

  return (
    <Flexbox
      style={{
        width: wide ? WIDE_WIDTH : RAIL_WIDTH,
        flexShrink: 0,
        height: '100%',
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorFillQuaternary,
        transition: 'width .15s ease',
        overflow: 'hidden',
      }}
    >
      <Flexbox
        horizontal
        align="center"
        justify={wide ? 'space-between' : 'center'}
        paddingInline={wide ? 12 : 0}
        paddingBlock={12}
      >
        {wide && (
          <Flexbox horizontal align="center" gap={8} style={{ minWidth: 0 }}>
            <Text fontSize={14} weight={700} ellipsis>
              pi webx
            </Text>
            {config?.piVersion && (
              <Text fontSize={11} style={{ color: token.colorTextQuaternary }}>
                pi {config.piVersion}
              </Text>
            )}
          </Flexbox>
        )}
        <Tooltip title={collapsed ? '展开侧栏' : '收起侧栏'}>
          <ActionIcon
            icon={PanelLeft}
            size="small"
            onClick={() => setCollapsed((prev) => !prev)}
          />
        </Tooltip>
      </Flexbox>

      <Flexbox paddingInline={wide ? 12 : 8} paddingBlock={4} gap={8}>
        <Tooltip title="新建会话" disabled={wide}>
          <button
            type="button"
            onClick={onNewSession}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              width: '100%',
              padding: '7px 0',
              fontSize: 12.5,
              cursor: 'pointer',
              color: token.colorTextLightSolid,
              background: token.colorPrimary,
              border: 'none',
              borderRadius: token.borderRadius,
            }}
          >
            <MessageSquarePlus size={14} />
            {wide && '新建会话'}
          </button>
        </Tooltip>
      </Flexbox>

      {wide ? (
        <div style={{ flex: 1, minHeight: 0, padding: '4px 8px 0', display: 'flex', flexDirection: 'column' }}>
          <Flexbox
            horizontal
            align="center"
            justify="space-between"
            paddingInline={4}
            paddingBlock={4}
          >
            <Text
              fontSize={11}
              weight={600}
              style={{ color: token.colorTextQuaternary, letterSpacing: 0.4 }}
            >
              工作区
            </Text>
            <Flexbox horizontal align="center" gap={2}>
              <Tooltip title="刷新历史">
                <ActionIcon icon={RefreshCw} size="small" spin={storedLoading} onClick={onRefreshStored} />
              </Tooltip>
              <Tooltip title="添加工作区">
                <ActionIcon icon={FolderPlus} size="small" onClick={onBrowseWorkspace} />
              </Tooltip>
            </Flexbox>
          </Flexbox>
          <WorkspaceTree
            groups={groups}
            activeId={activeId}
            home={config?.home}
            storedLoading={storedLoading}
            onPickWorkspace={onPickWorkspace}
            onCreateSession={onCreateSession}
            onSetDefault={onSetDefaultWorkspace}
            onForgetWorkspace={onForgetWorkspace}
            onSwitch={onSwitchSession}
            onKill={onKillSession}
            onResume={onResumeStored}
            onDeleteStored={onDeleteStored}
            onRename={onRenameSession}
          />
        </div>
      ) : (
        <Flexbox align="center" gap={4} paddingBlock={12} style={{ flex: 1 }}>
          <Tooltip title={`当前工作区：${currentTitle || '未选择'}`}>
            <Text fontSize={10} style={{ color: token.colorTextQuaternary, writingMode: 'vertical-rl' }}>
              {currentTitle}
            </Text>
          </Tooltip>
        </Flexbox>
      )}

      <Flexbox
        horizontal={wide}
        align="center"
        justify={wide ? 'space-between' : 'center'}
        gap={wide ? 2 : 6}
        paddingInline={wide ? 12 : 0}
        paddingBlock={8}
        style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Flexbox horizontal={wide} align="center" gap={wide ? 2 : 6}>
          <Tooltip title="模型配置">
            <ActionIcon icon={Cpu} size="small" onClick={onOpenModels} />
          </Tooltip>
          <Tooltip title="组件库">
            <ActionIcon icon={LayoutGrid} size="small" onClick={onOpenShowcase} />
          </Tooltip>
          <Tooltip title="会话设置">
            <ActionIcon icon={Settings2} size="small" onClick={onOpenSettings} />
          </Tooltip>
          <Tooltip title={themeMode === 'dark' ? '切换浅色' : '切换深色'}>
            <ActionIcon icon={themeMode === 'dark' ? Sun : Moon} size="small" onClick={onToggleTheme} />
          </Tooltip>
        </Flexbox>
        {wide && (
          <Flexbox horizontal align="center" gap={6}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                flexShrink: 0,
                background: connected ? token.colorSuccess : token.colorError,
              }}
            />
            <Text fontSize={11} style={{ color: token.colorTextQuaternary }}>
              {connected ? '已连接' : '未连接'}
            </Text>
          </Flexbox>
        )}
      </Flexbox>
    </Flexbox>
  );
}
