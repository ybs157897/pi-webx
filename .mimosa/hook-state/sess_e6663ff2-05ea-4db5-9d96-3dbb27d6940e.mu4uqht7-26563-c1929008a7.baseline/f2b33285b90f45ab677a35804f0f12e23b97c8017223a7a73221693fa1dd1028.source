/**
 * The model list inside the provider editor: one bordered row per model with its
 * identity, capabilities and a delete action. Purely presentational — the draft
 * lives in `ProviderEditor`, which also owns validation.
 */

import { ActionIcon, Flexbox, Text } from '@lobehub/ui';
import { Button, Input, Select, Switch, theme } from 'antd';
import { Plus, Trash2 } from 'lucide-react';

import { Field } from './Field';
import type { ModelDraft } from './providerDraft';

const INPUT_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图像' },
];

/* ------------------------------------------------------------------------- row */

/** One model of the provider: identity, capabilities and a delete action. */
function ModelRow({
  model,
  index,
  error,
  onChange,
  onRemove,
}: {
  model: ModelDraft;
  index: number;
  error?: string;
  onChange: (next: Partial<ModelDraft>) => void;
  onRemove: () => void;
}) {
  const { token } = theme.useToken();
  return (
    <Flexbox
      gap={8}
      padding={10}
      style={{
        border: `1px solid ${error !== undefined ? token.colorErrorBorder : token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
      }}
    >
      <Flexbox horizontal align="center" justify="space-between" gap={8}>
        <Text fontSize={11} weight={600} type="secondary">
          {`模型 ${index + 1}`}
        </Text>
        <ActionIcon icon={Trash2} size="small" danger title="删除该模型" onClick={onRemove} />
      </Flexbox>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="模型 ID" error={error}>
          <Input
            value={model.id}
            status={error !== undefined ? 'error' : undefined}
            placeholder="例如 deepseek/deepseek-v4-flash"
            onChange={(event) => onChange({ id: event.target.value })}
          />
        </Field>
        <Field label="显示名称">
          <Input
            value={model.name}
            placeholder="可留空"
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
        <Field label="上下文窗口">
          <Input
            value={model.contextWindow}
            inputMode="numeric"
            placeholder="例如 128000"
            onChange={(event) => onChange({ contextWindow: event.target.value })}
          />
        </Field>
        <Field label="最大输出">
          <Input
            value={model.maxTokens}
            inputMode="numeric"
            placeholder="例如 8192"
            onChange={(event) => onChange({ maxTokens: event.target.value })}
          />
        </Field>
        <Field label="推理（reasoning）">
          <Switch
            size="small"
            checked={model.reasoning}
            onChange={(checked) => onChange({ reasoning: checked })}
          />
        </Field>
        <Field label="输入类型">
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            value={model.input}
            options={INPUT_OPTIONS}
            placeholder="text / image"
            onChange={(value: string[]) => onChange({ input: value })}
          />
        </Field>
      </div>
    </Flexbox>
  );
}

/* ------------------------------------------------------------------- component */

export interface ModelListEditorProps {
  models: ModelDraft[];
  /** model draft key → message; only rendered once a save was attempted */
  errors: Record<string, string>;
  onAdd: () => void;
  onChange: (key: string, next: Partial<ModelDraft>) => void;
  onRemove: (key: string) => void;
}

export function ModelListEditor({ models, errors, onAdd, onChange, onRemove }: ModelListEditorProps) {
  const { token } = theme.useToken();
  return (
    <Flexbox gap={8}>
      <Flexbox horizontal align="center" justify="space-between" gap={8}>
        <Flexbox horizontal align="center" gap={6}>
          <Text fontSize={12} weight={600}>
            模型
          </Text>
          <Text fontSize={11} type="secondary">
            {`${models.length} 个`}
          </Text>
        </Flexbox>
        <Button size="small" icon={<Plus size={13} />} onClick={onAdd}>
          添加模型
        </Button>
      </Flexbox>

      {models.length === 0 ? (
        <Text fontSize={11.5} style={{ color: token.colorTextQuaternary }}>
          该 provider 暂无模型，点击「添加模型」补充。
        </Text>
      ) : (
        models.map((model, index) => (
          <ModelRow
            key={model.key}
            model={model}
            index={index}
            error={errors[model.key]}
            onChange={(next) => onChange(model.key, next)}
            onRemove={() => onRemove(model.key)}
          />
        ))
      )}
    </Flexbox>
  );
}

/* ------------------------------------------------------------------- asserts */

/**
 * Usage assert: `ProviderEditor` renders `<ModelListEditor {...props} />` with
 * exactly these props, so the list contract cannot change silently.
 */
const sampleListProps: ModelListEditorProps = {
  models: [],
  errors: {},
  onAdd: () => {},
  onChange: () => {},
  onRemove: () => {},
};

export type ModelListEditorPropsAssertion = typeof sampleListProps;
