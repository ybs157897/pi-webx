/**
 * 引导失败屏：桥接配置读不到、且还没有任何会话时的唯一界面（一个错误说明 + 重试）。
 */
import { Alert, Flexbox, Text } from '@lobehub/ui';
import { theme } from 'antd';

export interface BootErrorScreenProps {
  /** 引导失败的原始信息。 */
  error: string;
  /** 重试：重新读 bridge 配置并落入工作区。 */
  onRetry: () => void;
}

export function BootErrorScreen({ error, onRetry }: BootErrorScreenProps) {
  const { token } = theme.useToken();

  return (
    <Flexbox align="center" justify="center" style={{ height: '100vh', padding: 24 }}>
      <Flexbox gap={12} style={{ maxWidth: 620, width: '100%' }}>
        <Alert type="error" showIcon message="无法启动 pi 会话" description={error} />
        <Text fontSize={12} type="secondary">
          请确认桥接服务已启动（agent 通过内嵌的 pi SDK 在进程内运行），
          以及模型配置里有可用的模型和凭据。
        </Text>
        <button
          type="button"
          onClick={onRetry}
          style={{
            padding: '8px 16px',
            cursor: 'pointer',
            color: token.colorTextLightSolid,
            background: token.colorPrimary,
            border: 'none',
            borderRadius: token.borderRadius,
          }}
        >
          重试
        </button>
      </Flexbox>
    </Flexbox>
  );
}
