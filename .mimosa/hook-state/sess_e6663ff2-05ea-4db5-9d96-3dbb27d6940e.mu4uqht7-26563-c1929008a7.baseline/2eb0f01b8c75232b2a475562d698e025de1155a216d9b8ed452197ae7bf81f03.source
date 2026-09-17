import { Alert, Flexbox, Icon, Text } from '@lobehub/ui';
import { Progress, Tag, theme } from 'antd';
import { LoaderCircle, RotateCw } from 'lucide-react';

import type { PiSessionApi, WidgetState } from '../lib/usePiSession';
import { formatTokens } from '../lib/format';

/** Extension-pushed widgets, rendered as preformatted blocks near the composer. */
export function WidgetStrip({
  widgets,
  placement,
}: {
  widgets: Record<string, WidgetState>;
  placement: WidgetState['placement'];
}) {
  const { token } = theme.useToken();
  const entries = Object.entries(widgets).filter(([, widget]) => widget.placement === placement);
  if (entries.length === 0) return null;

  return (
    <Flexbox gap={6} paddingBlock={4}>
      {entries.map(([key, widget]) => (
        <pre
          key={key}
          style={{
            margin: 0,
            padding: '6px 10px',
            fontSize: 11.5,
            lineHeight: 1.55,
            fontFamily: token.fontFamilyCode,
            color: token.colorTextSecondary,
            background: token.colorFillQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
          }}
        >
          {widget.lines.join('\n')}
        </pre>
      ))}
    </Flexbox>
  );
}

/** Running / compacting / retrying banners plus extension status entries. */
export function StatusStrip({ api }: { api: PiSessionApi }) {
  const { token } = theme.useToken();
  const { retrying, compacting, running, statuses, stats } = {
    retrying: api.transcript.retrying,
    compacting: api.transcript.compacting,
    running: api.transcript.running,
    statuses: api.statuses,
    stats: api.stats,
  };

  const statusEntries = Object.entries(statuses);
  const contextUsage = stats?.contextUsage;
  const percent = contextUsage?.percent;
  const hasBanner = Boolean(retrying) || compacting;

  if (!hasBanner && statusEntries.length === 0 && !running) return null;

  return (
    <Flexbox gap={8} paddingBlock={6}>
      {retrying && (
        <Alert
          type="warning"
          variant="borderless"
          showIcon
          icon={<RotateCw size={14} />}
          message={`请求失败，正在重试${
            retrying.attempt !== undefined && retrying.maxAttempts !== undefined
              ? `（第 ${retrying.attempt}/${retrying.maxAttempts} 次）`
              : ''
          }`}
          {...(retrying.error === undefined ? {} : { description: retrying.error })}
        />
      )}

      {compacting && (
        <Flexbox horizontal align="center" gap={8} style={{ color: token.colorTextSecondary }}>
          <Icon icon={LoaderCircle} spin size={13} />
          <Text fontSize={12} type="secondary">
            正在压缩上下文…
          </Text>
        </Flexbox>
      )}

      {(statusEntries.length > 0 || contextUsage) && (
        <Flexbox horizontal align="center" gap={8} wrap="wrap">
          {statusEntries.map(([key, text]) => (
            <Tag key={key} style={{ fontSize: 11 }}>
              {text}
            </Tag>
          ))}
          {typeof percent === 'number' && (
            <Flexbox horizontal align="center" gap={6} style={{ minWidth: 160 }}>
              <Text fontSize={11} type="secondary">
                上下文
              </Text>
              <Progress
                percent={Math.min(100, Math.round(percent))}
                size="small"
                showInfo={false}
                style={{ width: 90, margin: 0 }}
                status={percent > 90 ? 'exception' : 'normal'}
              />
              <Text fontSize={11} type="secondary">
                {formatTokens(contextUsage?.tokens)} / {formatTokens(contextUsage?.contextWindow)}
              </Text>
            </Flexbox>
          )}
        </Flexbox>
      )}
    </Flexbox>
  );
}
