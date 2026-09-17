import { ActionIcon, Alert, Flexbox, Markdown, Text, Tooltip } from '@lobehub/ui';
import { Highlighter } from '@lobehub/ui';
import { Button, Checkbox, Divider, Form, Input, Select, Switch, Table, Tag, theme } from 'antd';
import type { Rule } from 'antd/es/form';
import { ArrowDownRight, ArrowUpRight, Copy, Send } from 'lucide-react';
import { useCallback } from 'react';

import { formatNumber } from '../../lib/format';
import type { UiButtonSpec, UiField, UiNode, UiSpec } from '../../shared/uikit';
import { UiChart } from './UiChart';

export interface UiRendererProps {
  spec: UiSpec;
  /** Firing an action sends it back to pi as a new user message. */
  onAction?: (action: string) => void;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
}

function ActionButton({ spec, onAction }: { spec: UiButtonSpec; onAction?: (a: string) => void }) {
  const isPrimary = spec.kind === 'primary';
  const isDanger = spec.kind === 'danger';
  return (
    <Button
      type={isPrimary || isDanger ? 'primary' : 'default'}
      danger={isDanger}
      {...(spec.kind === 'dashed' ? { ghost: true } : {})}
      onClick={() => onAction?.(spec.action ?? spec.v)}
    >
      {spec.v}
    </Button>
  );
}

function StatCard({
  label,
  value,
  unit,
  trend,
  hint,
}: {
  label: string;
  value: number | string;
  unit?: string | undefined;
  trend?: 'up' | 'down' | undefined;
  hint?: string | undefined;
}) {
  const { token } = theme.useToken();
  const TrendIcon = trend === 'up' ? ArrowUpRight : ArrowDownRight;
  return (
    <div
      style={{
        padding: '12px 14px',
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
        minWidth: 150,
        flex: '1 1 150px',
      }}
    >
      <Text fontSize={12} type="secondary">
        {label}
      </Text>
      <Flexbox horizontal align="baseline" gap={4}>
        <Text fontSize={24} weight={600} style={{ color: token.colorText }}>
          {typeof value === 'number' ? formatNumber(value) : value}
        </Text>
        {unit && (
          <Text fontSize={12} type="secondary">
            {unit}
          </Text>
        )}
        {trend && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              color: trend === 'up' ? token.colorSuccess : token.colorError,
            }}
          >
            <TrendIcon size={14} />
          </span>
        )}
      </Flexbox>
      {hint && (
        <Text fontSize={11} type="secondary">
          {hint}
        </Text>
      )}
    </div>
  );
}

function UiFormBlock({
  title,
  fields,
  submit,
  action,
  onAction,
}: {
  title?: string | undefined;
  fields: UiField[];
  submit?: string | undefined;
  action?: string | undefined;
  onAction?: (a: string) => void;
}) {
  const [form] = Form.useForm();

  const onSubmit = useCallback(
    (values: Record<string, unknown>) => {
      const header = action ?? title ?? '表单提交';
      const lines = fields
        .filter((field) => {
          const value = values[field.k];
          return value !== undefined && value !== null && `${value}`.length > 0;
        })
        .map((field) => `· ${field.label}: ${String(values[field.k])}`);
      onAction?.([header, ...lines].join('\n'));
      form.resetFields();
    },
    [action, fields, form, onAction, title],
  );

  return (
    <div style={{ maxWidth: 560 }}>
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        {fields.map((field) => {
          const rules: Rule[] | undefined = field.required
            ? [{ required: true, message: `请填写${field.label}` }]
            : undefined;

          if (field.t === 'select') {
            return (
              <Form.Item key={field.k} name={field.k} label={field.label} rules={rules}>
                <Select
                  placeholder={field.ph ?? `选择${field.label}`}
                  options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
                  allowClear
                />
              </Form.Item>
            );
          }
          if (field.t === 'checkbox') {
            return (
              <Form.Item
                key={field.k}
                name={field.k}
                valuePropName="checked"
                {...(field.checked === undefined ? {} : { initialValue: field.checked })}
              >
                <Checkbox>{field.label}</Checkbox>
              </Form.Item>
            );
          }
          if (field.t === 'switch') {
            return (
              <Form.Item
                key={field.k}
                name={field.k}
                label={field.label}
                valuePropName="checked"
                {...(field.checked === undefined ? {} : { initialValue: field.checked })}
              >
                <Switch size="small" />
              </Form.Item>
            );
          }
          if (field.t === 'textarea') {
            return (
              <Form.Item key={field.k} name={field.k} label={field.label} rules={rules}>
                <Input.TextArea placeholder={field.ph} rows={field.rows ?? 3} />
              </Form.Item>
            );
          }
          return (
            <Form.Item key={field.k} name={field.k} label={field.label} rules={rules}>
              <Input type={field.kind ?? 'text'} placeholder={field.ph} />
            </Form.Item>
          );
        })}
        <Button type="primary" htmlType="submit" icon={<Send size={13} />}>
          {submit ?? '提交'}
        </Button>
      </Form>
    </div>
  );
}

function DescriptionsTable({
  title,
  items,
  cols,
}: {
  title?: string | undefined;
  items: { key: string; label: string; value: string }[];
  cols: number;
}) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        overflow: 'hidden',
      }}
    >
      {title && (
        <div
          style={{
            padding: '8px 12px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.max(1, Math.min(3, cols))}, minmax(0, 1fr))`,
        }}
      >
        {items.map((item) => (
          <div
            key={item.key}
            style={{
              padding: '8px 12px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              borderRight: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <Text fontSize={11} type="secondary">
              {item.label}
            </Text>
            <div style={{ fontSize: 13, color: token.colorText, wordBreak: 'break-word' }}>
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeView({ node, onAction }: { node: UiNode; onAction?: (a: string) => void }) {
  const { token } = theme.useToken();

  switch (node.t) {
    case 'row':
      return (
        <Flexbox
          horizontal
          gap={node.gap ?? 12}
          align={node.align}
          wrap={node.wrap ? 'wrap' : undefined}
        >
          {(node.children ?? []).map((child, index) => (
            <NodeView key={String(index)} node={child} onAction={onAction} />
          ))}
        </Flexbox>
      );

    case 'col':
      return (
        <Flexbox gap={node.gap ?? 12}>
          {(node.children ?? []).map((child, index) => (
            <NodeView key={String(index)} node={child} onAction={onAction} />
          ))}
        </Flexbox>
      );

    case 'card': {
      const body = (
        <Flexbox gap={12}>
          {(node.children ?? []).map((child, index) => (
            <NodeView key={String(index)} node={child} onAction={onAction} />
          ))}
        </Flexbox>
      );
      const surfaceStyle = {
        border: `1px solid ${node.variant === 'flat' ? 'transparent' : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: node.variant === 'highlight' ? token.colorFillQuaternary : 'transparent',
      } as const;
      if (!node.title) {
        return (
          <div style={{ ...surfaceStyle, padding: 14 }}>{body}</div>
        );
      }
      return (
        <div style={{ ...surfaceStyle, overflow: 'hidden' }}>
          <div
            style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            {node.title}
          </div>
          <div style={{ padding: 14 }}>{body}</div>
        </div>
      );
    }

    case 'divider':
      return <Divider style={{ margin: '4px 0' }} />;

    case 'title': {
      const size = node.level === 1 ? 20 : node.level === 2 ? 17 : node.level === 3 ? 15 : 14;
      return (
        <Text fontSize={size} weight={600}>
          {node.v}
        </Text>
      );
    }

    case 'text':
      return (
        <Text
          fontSize={13.5}
          type={node.kind === 'secondary' ? 'secondary' : undefined}
          code={node.kind === 'code'}
          strong={node.kind === 'strong'}
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {node.v}
        </Text>
      );

    case 'md':
      return (
        <Markdown variant="chat" fontSize={13.5} enableStream={false}>
          {node.v}
        </Markdown>
      );

    case 'stat':
      return (
        <StatCard
          label={node.label}
          value={node.value}
          {...(node.unit === undefined ? {} : { unit: node.unit })}
          {...(node.trend === undefined ? {} : { trend: node.trend })}
          {...(node.hint === undefined ? {} : { hint: node.hint })}
        />
      );

    case 'table': {
      const columns = node.columns.map((column) => ({
        title: column.title,
        dataIndex: column.k,
        key: column.k,
        width: column.w,
        ellipsis: true,
        render: (value: unknown) => cellText(value),
      }));
      const rows = node.rows.map((row, index) => ({ ...row, __key: String(index) }));
      return (
        <Table
          size="small"
          columns={columns}
          dataSource={rows}
          rowKey="__key"
          pagination={rows.length > 10 ? { pageSize: 10, size: 'small' } : false}
        />
      );
    }

    case 'desc':
      return (
        <DescriptionsTable
          title={node.title}
          cols={node.cols ?? 1}
          items={node.items.map((item) => ({
            key: item.k,
            label: item.k,
            value: cellText(item.v),
          }))}
        />
      );

    case 'tags':
      return (
        <Flexbox horizontal gap={6} wrap="wrap">
          {node.items.map((item, index) => (
            <Tag key={`${item}-${String(index)}`} style={{ fontSize: 12 }}>
              {item}
            </Tag>
          ))}
        </Flexbox>
      );

    case 'callout':
      return (
        <Alert
          type={node.kind ?? 'info'}
          variant="borderless"
          showIcon
          message={node.title ?? node.v}
          {...(node.title === undefined ? {} : { description: node.v })}
        />
      );

    case 'code':
      return (
        <Highlighter language={node.lang ?? 'text'} variant="outlined" wrap>
          {node.v}
        </Highlighter>
      );

    case 'list':
      return (
        <Flexbox gap={6}>
          {node.items.map((item, index) => {
            const isObject = typeof item === 'object' && item !== null;
            const title = isObject ? String(item['title'] ?? '') : String(item);
            const desc = isObject && typeof item['desc'] === 'string' ? item['desc'] : undefined;
            return (
              <Flexbox horizontal align="flex-start" gap={8} key={String(index)}>
                <span
                  style={{
                    flexShrink: 0,
                    marginTop: 7,
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: token.colorPrimary,
                  }}
                />
                <Flexbox gap={0} style={{ minWidth: 0 }}>
                  <Text fontSize={13.5}>{title}</Text>
                  {desc && (
                    <Text fontSize={12} type="secondary">
                      {desc}
                    </Text>
                  )}
                </Flexbox>
              </Flexbox>
            );
          })}
        </Flexbox>
      );

    case 'form':
      return (
        <UiFormBlock
          title={node.title}
          fields={node.fields}
          {...(node.submit === undefined ? {} : { submit: node.submit })}
          {...(node.action === undefined ? {} : { action: node.action })}
          onAction={onAction}
        />
      );

    case 'button':
      return (
        <ActionButton
          spec={{
            v: node.v,
            ...(node.kind ? { kind: node.kind } : {}),
            ...(node.action ? { action: node.action } : {}),
          }}
          onAction={onAction}
        />
      );

    case 'btngroup':
      return (
        <Flexbox horizontal gap={8} wrap="wrap">
          {node.buttons.map((button, index) => (
            <ActionButton key={String(index)} spec={button} onAction={onAction} />
          ))}
        </Flexbox>
      );

    case 'chart':
      return (
        <UiChart
          kind={node.kind}
          labels={node.labels}
          series={node.series}
          {...(node.height === undefined ? {} : { height: node.height })}
        />
      );

    default:
      return null;
  }
}

export function UiRenderer({ spec, onAction }: UiRendererProps) {
  const { token } = theme.useToken();
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(spec, null, 2));
  }, [spec]);

  return (
    <Flexbox gap={16}>
      <Flexbox horizontal align="center" justify="space-between">
        <Text fontSize={13} type="secondary">
          {spec.title ?? '组件视图'}
        </Text>
        <Tooltip title="复制这份 UI 规格 (JSON)">
          <ActionIcon icon={Copy} size="small" onClick={copy} />
        </Tooltip>
      </Flexbox>
      <Flexbox
        gap={16}
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          padding: 16,
          background: token.colorBgContainer,
        }}
      >
        {spec.root.map((node, index) => (
          <NodeView key={String(index)} node={node} onAction={onAction} />
        ))}
      </Flexbox>
    </Flexbox>
  );
}
