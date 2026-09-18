import { Flexbox, Text } from '@lobehub/ui';
import { App as AntApp, Button, Drawer, Select, Switch, theme } from 'antd';
import { Archive, Download } from 'lucide-react';
import type { ReactNode } from 'react';

import { THINKING_LABELS } from '../lib/format';
import type { PiSessionApi } from '../lib/usePiSession';
import { PI_THINKING_LEVELS, type PiThinkingLevel } from '../shared/protocol';

type QueueMode = 'all' | 'one-at-a-time';

const QUEUE_MODE_LABELS: Record<QueueMode, string> = {
  all: '全部送达',
  'one-at-a-time': '逐条送达',
};

function Row({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <Flexbox horizontal align="center" justify="space-between" gap={16} paddingBlock={10}>
      <Flexbox gap={2} style={{ minWidth: 0 }}>
        <Text fontSize={13}>{title}</Text>
        <Text fontSize={11.5} type="secondary" style={{ lineHeight: 1.5 }}>
          {description}
        </Text>
      </Flexbox>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </Flexbox>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { token } = theme.useToken();
  return (
    <Flexbox gap={4} paddingBlock={6}>
      <Text
        fontSize={11}
        weight={600}
        style={{ color: token.colorTextQuaternary, letterSpacing: 0.4 }}
      >
        {title}
      </Text>
      {children}
    </Flexbox>
  );
}

const divider = { borderBottom: '1px solid', borderColor: 'inherit' } as const;

export interface SessionSettingsProps {
  open: boolean;
  onClose: () => void;
  api: PiSessionApi;
  disabled: boolean;
}

/**
 * pi's per-session configuration surface. Every control maps to one pi RPC
 * command and re-reads state on success, so the values shown track pi.
 */
export function SessionSettings({ open, onClose, api, disabled }: SessionSettingsProps) {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();

  const state = api.piState;
  const levels = api.thinkingLevels.length > 0 ? api.thinkingLevels : PI_THINKING_LEVELS;
  const thinking = (state?.thinkingLevel ?? 'medium') as PiThinkingLevel;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="会话设置"
      width={420}
      destroyOnHidden
    >
      <Flexbox gap={8}>
        <Section title="模型">
          <Row
            title="思考等级"
            description="越高推理越充分，也更慢、更贵。取值来自当前模型支持的范围。"
            control={
              <Select
                size="small"
                style={{ width: 120 }}
                value={thinking}
                disabled={disabled}
                onChange={(value: PiThinkingLevel) => {
                  void api.setThinkingLevel(value);
                }}
                options={levels.map((level) => ({
                  value: level,
                  label: THINKING_LABELS[level] ?? level,
                }))}
              />
            }
          />
          <Row
            title="自动压缩上下文"
            description="上下文接近模型上限时自动压缩，避免长会话中断。"
            control={
              <Switch
                size="small"
                disabled={disabled}
                checked={state?.autoCompactionEnabled ?? true}
                onChange={(checked) => void api.setAutoCompaction(checked)}
              />
            }
          />
        </Section>

        <Section title="消息队列">
          <Row
            title="插话（steer）处理"
            description="任务执行中收到的新指令，是全部依次执行，还是逐条确认。"
            control={
              <Select
                size="small"
                style={{ width: 120 }}
                value={(state?.steeringMode ?? 'all') as QueueMode}
                disabled={disabled}
                onChange={(value: QueueMode) => void api.setSteeringMode(value)}
                options={(Object.keys(QUEUE_MODE_LABELS) as QueueMode[]).map((mode) => ({
                  value: mode,
                  label: QUEUE_MODE_LABELS[mode],
                }))}
              />
            }
          />
          <Row
            title="后续消息（follow-up）处理"
            description="任务完成后追加的消息如何消费。"
            control={
              <Select
                size="small"
                style={{ width: 120 }}
                value={(state?.followUpMode ?? 'one-at-a-time') as QueueMode}
                disabled={disabled}
                onChange={(value: QueueMode) => void api.setFollowUpMode(value)}
                options={(Object.keys(QUEUE_MODE_LABELS) as QueueMode[]).map((mode) => ({
                  value: mode,
                  label: QUEUE_MODE_LABELS[mode],
                }))}
              />
            }
          />
        </Section>

        <Section title="维护">
          <Row
            title="立即压缩上下文"
            description="手动触发一次压缩，通常在上下文用量偏高时使用。"
            control={
              <Button
                size="small"
                icon={<Archive size={13} />}
                disabled={disabled || api.transcript.running || api.transcript.compacting}
                onClick={() => {
                  void api.compact().then(() => message.success('已开始压缩'));
                }}
              >
                压缩
              </Button>
            }
          />
          <Row
            title="导出会话为 HTML"
            description="由 pi 生成整份会话的 HTML 归档，路径会复制到剪贴板。"
            control={
              <Button
                size="small"
                icon={<Download size={13} />}
                disabled={disabled}
                onClick={() => {
                  void api.exportHtml().then((result) => {
                    if (!result) {
                      message.error('导出失败');
                      return;
                    }
                    void navigator.clipboard.writeText(result.path);
                    message.success(`已导出并复制路径：${result.path}`);
                  });
                }}
              >
                导出
              </Button>
            }
          />
        </Section>

        {api.sessionFile && (
          <Section title="会话文件">
            <Text
              fontSize={11.5}
              type="secondary"
              style={{
                fontFamily: token.fontFamilyCode,
                wordBreak: 'break-all',
                background: token.colorFillQuaternary,
                padding: '6px 8px',
                borderRadius: token.borderRadius,
                ...divider,
              }}
            >
              {api.sessionFile}
            </Text>
          </Section>
        )}
      </Flexbox>
    </Drawer>
  );
}
