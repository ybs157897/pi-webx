import { ActionIcon, Alert, Flexbox } from '@lobehub/ui';
import { theme } from 'antd';
import { X } from 'lucide-react';

import type { AppNotification } from '../lib/usePiSession';

export function NotificationStack({
  notifications,
  onDismiss,
}: {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
}) {
  const { token } = theme.useToken();
  if (notifications.length === 0) return null;

  return (
    <Flexbox
      gap={8}
      style={{
        position: 'fixed',
        right: 20,
        top: 64,
        zIndex: 1200,
        width: 360,
        maxWidth: 'calc(100vw - 40px)',
        maxHeight: '50vh',
        overflowY: 'auto',
      }}
    >
      {notifications.slice(-4).map((entry) => (
        <Alert
          key={entry.id}
          type={entry.level}
          variant="outlined"
          showIcon
          message={entry.text}
          {...(entry.detail === undefined ? {} : { description: entry.detail })}
          style={{ background: token.colorBgElevated, boxShadow: token.boxShadowSecondary }}
          action={
            <ActionIcon icon={X} size="small" aria-label="关闭通知" title="关闭" onClick={() => onDismiss(entry.id)} />
          }
        />
      ))}
    </Flexbox>
  );
}
