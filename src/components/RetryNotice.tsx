import { Alert } from '@lobehub/ui';
import { RotateCw } from 'lucide-react';

import { failureCopy } from '../lib/failure';
import type { RetryInfo } from '../shared/transcript';

/**
 * 自动重试期间的提示。
 *
 * 文案跟着失败归因走（见 `lib/failure.ts`）：断网、上游抖动、超时各说各的，
 * 用户不用读原始 5xx 才知道发生了什么；原始错误留在可展开的详情里备查。
 */
export function RetryNotice({ retry }: { retry: RetryInfo }) {
  const failure = failureCopy(retry.error);
  const attempt =
    retry.attempt !== undefined
      ? `（第 ${retry.attempt}${retry.maxAttempts === undefined ? '' : `/${retry.maxAttempts}`} 次）`
      : '';
  return (
    <Alert
      type="warning"
      variant="borderless"
      showIcon
      icon={<RotateCw size={14} />}
      message={`${failure.title}，正在自动重试${attempt}`}
      description={
        retry.error === undefined ? failure.detail : `${failure.detail} 原始错误：${retry.error}`
      }
    />
  );
}
