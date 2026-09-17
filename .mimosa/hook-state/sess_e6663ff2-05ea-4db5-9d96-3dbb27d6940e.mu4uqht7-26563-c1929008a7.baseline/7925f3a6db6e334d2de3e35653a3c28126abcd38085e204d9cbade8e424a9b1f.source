import { ActionIcon, Block, Flexbox, Icon, Text, Tooltip } from '@lobehub/ui';
import { theme } from 'antd';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Copy,
  FilePlus,
  FileText,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { countLines, formatArgs, formatRelativeTime, summarizeToolCall } from '../lib/format';
import type { ToolRun } from '../shared/transcript';

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  powershell: Terminal,
  read: FileText,
  write: FilePlus,
  edit: Pencil,
  grep: Search,
  find: Search,
  ls: FolderOpen,
};

/** Tail length kept visible while the card is collapsed. */
const COLLAPSED_LINES = 8;

function tail(value: string, lines: number): string {
  const all = value.split('\n');
  if (all.length <= lines) return value;
  return all.slice(all.length - lines).join('\n');
}

export function ToolCard({ run }: { run: ToolRun }) {
  const { token } = theme.useToken();
  const [manual, setManual] = useState<boolean | null>(null);

  // Running and failed calls open themselves; a successful one collapses unless
  // the user has explicitly toggled it.
  const open = manual ?? (run.status === 'running' || run.status === 'error');
  const summary = summarizeToolCall(run.toolName, run.args);
  const lineCount = countLines(run.output);
  const duration = run.endedAt ? run.endedAt - run.startedAt : null;

  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(run.output);
  }, [run.output]);

  const statusMeta = useMemo(() => {
    switch (run.status) {
      case 'running':
        return { icon: LoaderCircle, color: token.colorPrimary, label: '运行中', spin: true };
      case 'error':
        return { icon: CircleX, color: token.colorError, label: '失败', spin: false };
      default:
        return { icon: CircleCheck, color: token.colorSuccess, label: '完成', spin: false };
    }
  }, [run.status, token.colorError, token.colorPrimary, token.colorSuccess]);

  const ToolIcon = TOOL_ICONS[run.toolName] ?? Wrench;
  const StatusIcon = statusMeta.icon;

  return (
    <Block
      variant="outlined"
      padding={0}
      style={{
        borderRadius: token.borderRadiusLG,
        overflow: 'hidden',
        background: token.colorFillQuaternary,
        borderColor: run.status === 'error' ? token.colorErrorBorder : token.colorBorderSecondary,
      }}
    >
      <Flexbox
        horizontal
        align="center"
        gap={8}
        paddingInline={10}
        paddingBlock={8}
        style={{ cursor: 'pointer' }}
        onClick={() => setManual(!open)}
      >
        <Icon icon={open ? ChevronDown : ChevronRight} size={14} style={{ color: token.colorTextTertiary }} />
        <Icon icon={ToolIcon} size={14} style={{ color: token.colorTextSecondary }} />
        <Text fontSize={12} weight={600} style={{ fontFamily: token.fontFamilyCode, flexShrink: 0 }}>
          {run.toolName}
        </Text>
        {summary.length > 0 && (
          <Text
            fontSize={12}
            type="secondary"
            ellipsis
            style={{ fontFamily: token.fontFamilyCode, flex: 1, minWidth: 0 }}
          >
            {summary}
          </Text>
        )}
        {summary.length === 0 && <div style={{ flex: 1 }} />}
        {lineCount > 0 && (
          <Text fontSize={11} type="secondary" style={{ flexShrink: 0 }}>
            {lineCount} 行
          </Text>
        )}
        {duration !== null && duration > 200 && (
          <Text fontSize={11} type="secondary" style={{ flexShrink: 0 }}>
            {(duration / 1000).toFixed(1)}s
          </Text>
        )}
        <Tooltip title={statusMeta.label}>
          <Icon
            icon={StatusIcon}
            size={14}
            spin={statusMeta.spin}
            style={{ color: statusMeta.color, flexShrink: 0 }}
          />
        </Tooltip>
      </Flexbox>

      {open ? (
        <Flexbox gap={8} paddingInline={10} paddingBlock={10} style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}>
          {Object.keys(run.args).length > 0 && (
            <Flexbox gap={4}>
              <Text fontSize={11} type="secondary">
                参数
              </Text>
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  maxHeight: 200,
                  overflow: 'auto',
                  fontSize: 12,
                  lineHeight: 1.55,
                  fontFamily: token.fontFamilyCode,
                  color: token.colorText,
                  background: token.colorFillTertiary,
                  borderRadius: token.borderRadius,
                }}
              >
                {formatArgs(run.args)}
              </pre>
            </Flexbox>
          )}

          {run.output.length > 0 && (
            <Flexbox gap={4}>
              <Flexbox horizontal align="center" justify="space-between">
                <Text fontSize={11} type="secondary">
                  输出
                </Text>
                <ActionIcon icon={Copy} size="small" title="复制输出" onClick={onCopy} />
              </Flexbox>
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  maxHeight: 420,
                  overflow: 'auto',
                  fontSize: 12,
                  lineHeight: 1.55,
                  fontFamily: token.fontFamilyCode,
                  color: run.status === 'error' ? token.colorError : token.colorText,
                  background: token.colorFillTertiary,
                  borderRadius: token.borderRadius,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {run.output}
              </pre>
            </Flexbox>
          )}

          {run.output.length === 0 && run.status === 'running' && (
            <Text fontSize={12} type="secondary">
              等待输出…
            </Text>
          )}
        </Flexbox>
      ) : (
        run.output.length > 0 && (
          <div
            style={{
              padding: '6px 10px 8px',
              borderTop: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <pre
              style={{
                margin: 0,
                fontSize: 11.5,
                lineHeight: 1.5,
                fontFamily: token.fontFamilyCode,
                color: token.colorTextTertiary,
                maxHeight: 120,
                overflow: 'hidden',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {tail(run.output, COLLAPSED_LINES)}
            </pre>
          </div>
        )
      )}
    </Block>
  );
}

/** Compact one-line rendering used for tool results without a matching call. */
export function ToolCardHeader({ run }: { run: ToolRun }) {
  const { token } = theme.useToken();
  const ToolIcon = TOOL_ICONS[run.toolName] ?? Wrench;
  const summary = summarizeToolCall(run.toolName, run.args);
  return (
    <Flexbox horizontal align="center" gap={8} style={{ color: token.colorTextSecondary }}>
      <Icon icon={ToolIcon} size={14} />
      <Text fontSize={12} style={{ fontFamily: token.fontFamilyCode }}>
        {run.toolName}
      </Text>
      {summary.length > 0 && (
        <Text fontSize={12} type="secondary" ellipsis style={{ fontFamily: token.fontFamilyCode }}>
          {summary}
        </Text>
      )}
      <Text fontSize={11} type="secondary">
        {formatRelativeTime(run.startedAt)}
      </Text>
    </Flexbox>
  );
}
