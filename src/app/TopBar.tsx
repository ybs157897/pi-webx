/**
 * 顶栏：会话标题 + 会话菜单（左）、状态/团队标签与全局动作（右）。
 *
 * 外面那层 52px 的定位框是给 LobeHub `ChatHeader` 的兜底，原因见下面原文注释；
 * 它必须留在这里，因为框和栏是一体的一块。
 */
import { ActionIcon, Flexbox, Text, Tooltip } from '@lobehub/ui';
import { ChatHeader } from '@lobehub/ui/chat';
import { Dropdown, Tag, theme } from 'antd';
import type { MenuProps } from 'antd';
import { Ellipsis, LayoutGrid, RefreshCw, Settings2, UsersRound } from 'lucide-react';

import type { PiSessionApi } from '../lib/usePiSession';
import { STATUS_LABEL } from './connection';

export interface TopBarProps {
  session: PiSessionApi;
  title: string;
  narrowViewport: boolean;
  menuItems: MenuProps['items'];
  onMenuClick: (key: string) => void;
  /** 会话或待建会话是 Agent Team 时显示团队标签。 */
  showTeamTag: boolean;
  sessionId: string | null;
  onOpenTeamPanel: () => void;
  onOpenSessionSettings: () => void;
}

export function TopBar({
  session,
  title,
  narrowViewport,
  menuItems,
  onMenuClick,
  showTeamTag,
  sessionId,
  onOpenTeamPanel,
  onOpenSessionSettings,
}: TopBarProps) {
  const { token } = theme.useToken();

  return (
    /* LobeHub's ChatHeader is `position: absolute; width: 100%`, sized
        against its containing block because the layout it ships for is a CSS
        grid whose header area is 52px tall. A flex column gives it neither,
        and both halves of that went wrong: `width: 100%` resolved against a
        full-width ancestor, so the bar stretched 260px past this column (its
        right-hand controls — status, refresh, session settings — landed off
        screen with nothing able to scroll to them), and being out of flow it
        reserved no height, so the first 52px of content sat underneath it.
        This wrapper supplies exactly what the grid would: a 52px box that is
        positioned, so the bar spans the column and the content starts below
        it. */
    <div style={{ position: 'relative', height: 52, flex: 'none' }}>
      <ChatHeader
        left={
          <Flexbox horizontal align="center" gap={6}>
            <Text fontSize={14} weight={600} ellipsis style={{ maxWidth: narrowViewport ? 112 : 320 }}>
              {title}
            </Text>
            <Dropdown
              trigger={['click']}
              menu={{ items: menuItems, onClick: ({ key }) => onMenuClick(String(key)) }}
            >
              <ActionIcon icon={Ellipsis} size="small" />
            </Dropdown>
          </Flexbox>
        }
        right={
          <Flexbox horizontal align="center" gap={4}>
            <Tag
              style={{ fontSize: 11, marginRight: 4, display: narrowViewport ? 'none' : undefined }}
              color={
                session.status === 'live'
                  ? session.transcript.running
                    ? 'processing'
                    : 'success'
                  : session.status === 'error' || session.status === 'exited'
                    ? 'error'
                    : 'default'
              }
            >
              {session.transcript.running ? '执行中' : STATUS_LABEL[session.status]}
            </Tag>
            {showTeamTag && (
              <Tag color="blue" style={{ fontSize: 11, marginRight: 4, display: narrowViewport ? 'none' : undefined }}>Agent Team</Tag>
            )}
            <Tooltip title="团队面板">
              <ActionIcon
                icon={UsersRound}
                size="small"
                aria-label="团队面板"
                onClick={onOpenTeamPanel}
              />
            </Tooltip>
            <Tooltip title="刷新状态">
              <ActionIcon
                icon={RefreshCw}
                size="small"
                disabled={sessionId === null}
                onClick={() => void session.refreshState()}
              />
            </Tooltip>
            <Tooltip title="会话设置">
              <ActionIcon icon={Settings2} size="small" onClick={onOpenSessionSettings} />
            </Tooltip>
            <Tooltip title="个人工作台">
              <ActionIcon icon={LayoutGrid} size="small" aria-label="返回个人工作台" onClick={() => { window.location.assign('/'); }} />
            </Tooltip>
          </Flexbox>
        }
        styles={{
          center: {
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
          },
        }}
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, flexShrink: 0 }}
      />
    </div>
  );
}
