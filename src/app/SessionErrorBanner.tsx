/**
 * 会话级错误横幅：pi 报出的最后一个错误，可关闭。
 */
import { Alert } from '@lobehub/ui';

export interface SessionErrorBannerProps {
  message: string;
}

export function SessionErrorBanner({ message }: SessionErrorBannerProps) {
  return (
    <Alert
      type="warning"
      variant="borderless"
      showIcon
      closable
      message={message}
      style={{ margin: '8px 16px 0' }}
    />
  );
}
