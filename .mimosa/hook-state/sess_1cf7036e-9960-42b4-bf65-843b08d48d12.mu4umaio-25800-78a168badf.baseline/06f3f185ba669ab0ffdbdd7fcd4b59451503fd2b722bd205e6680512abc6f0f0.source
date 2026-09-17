/**
 * Composer bottom-bar model control, LobeChat-style: the active model's display
 * name, the thinking level as a compact pill beside it, and a shortcut into the
 * model browser.
 *
 * Purely presentational — every change is reported through props so the parent
 * stays the single owner of session state.
 */

import { ActionIcon, Flexbox, Text } from '@lobehub/ui';
import type { SelectProps } from 'antd';
import { Select, theme } from 'antd';
import { Settings2 } from 'lucide-react';
import { useMemo } from 'react';

import { THINKING_LABELS, formatTokens } from '../lib/format';
import { PI_THINKING_LEVELS, type PiModel, type PiThinkingLevel } from '../shared/protocol';

/* ------------------------------------------------------------------ selection */

/** A model addressed the way pi's RPC addresses it: provider + model id. */
export interface ModelSelection {
  provider: string;
  id: string;
}

/** Stable key for a selection; also the value carried by the model `Select`. */
export function modelSelectionKey(selection: ModelSelection): string {
  return `${selection.provider}/${selection.id}`;
}

/** Inverse of {@link modelSelectionKey}; `null` when the key is malformed. */
export function parseModelSelectionKey(key: string): ModelSelection | null {
  const separator = key.indexOf('/');
  if (separator <= 0 || separator >= key.length - 1) return null;
  return { provider: key.slice(0, separator), id: key.slice(separator + 1) };
}

/** Selection comparison that treats two `null`s as equal. */
export function sameModelSelection(a: ModelSelection | null, b: ModelSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.provider === b.provider && a.id === b.id;
}

/* --------------------------------------------------------------------- helpers */

/** A single antd option entry; the group wrapper reuses the same shape. */
type PickerOption = NonNullable<SelectProps['options']>[number];

/** `128k`-style hint for the popup rows; empty when pi reported no context window. */
function contextHint(model: PiModel): string {
  const contextWindow = model.contextWindow;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return '';
  }
  return formatTokens(contextWindow);
}

/**
 * `models` is scoped by pi and may not contain the model that is actually running
 * (e.g. a resumed session on a model outside the current list). Fall back to the
 * raw `provider/id` so the control never renders blank.
 */
function resolveDisplayName(models: PiModel[], current: ModelSelection | null): string | null {
  if (current === null) return null;
  const match = models.find(
    (model) => model.provider === current.provider && model.id === current.id,
  );
  if (match) return match.name || match.id;
  return modelSelectionKey(current);
}

/**
 * Options carry ReactNode labels, so search matches a precomputed haystack
 * instead of the rendered label. Group entries have no haystack: a hit on the
 * provider name keeps every model underneath it.
 */
function filterModelOption(input: string, option?: PickerOption): boolean {
  const query = input.trim().toLowerCase();
  if (query.length === 0) return true;
  const haystack = option?.['searchText'];
  if (typeof haystack === 'string') return haystack.includes(query);
  const groupLabel = option?.['label'];
  return typeof groupLabel === 'string' && groupLabel.toLowerCase().includes(query);
}

/* ------------------------------------------------------------------ component */

export interface ModelPickerProps {
  models: PiModel[];
  current: ModelSelection | null;
  thinkingLevels: PiThinkingLevel[];
  thinkingLevel: PiThinkingLevel | null;
  disabled?: boolean;
  loading?: boolean;
  onPickModel: (selection: ModelSelection) => void;
  onPickThinking: (level: PiThinkingLevel) => void;
  onOpenBrowser: () => void;
}

export function ModelPicker({
  models,
  current,
  thinkingLevels,
  thinkingLevel,
  disabled = false,
  loading = false,
  onPickModel,
  onPickThinking,
  onOpenBrowser,
}: ModelPickerProps) {
  const { token } = theme.useToken();
  const fontFamilyCode = token.fontFamilyCode;

  const modelGroups = useMemo<PickerOption[]>(() => {
    const byProvider = new Map<string, PiModel[]>();
    for (const model of models) {
      const list = byProvider.get(model.provider);
      if (list) list.push(model);
      else byProvider.set(model.provider, [model]);
    }

    return Array.from(byProvider.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, list]) => ({
        label: provider,
        options: [...list]
          .sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id))
          .map((model) => {
            const name = model.name || model.id;
            const context = contextHint(model);
            return {
              value: modelSelectionKey({ provider: model.provider, id: model.id }),
              searchText: `${name} ${provider} ${model.id}`.toLowerCase(),
              label: (
                <Flexbox
                  horizontal
                  align="center"
                  justify="space-between"
                  gap={12}
                  style={{ minWidth: 0 }}
                >
                  <Text ellipsis style={{ minWidth: 0 }}>
                    {name}
                  </Text>
                  {context !== '' && (
                    <Text
                      fontSize={11}
                      type="secondary"
                      style={{ flexShrink: 0, fontFamily: fontFamilyCode }}
                    >
                      {context}
                    </Text>
                  )}
                </Flexbox>
              ),
            };
          }),
      }));
  }, [models, fontFamilyCode]);

  // pi reports which levels it accepts; fall back to the protocol list so the
  // control is never empty while `get_available_thinking_levels` is in flight.
  const levels = thinkingLevels.length > 0 ? thinkingLevels : PI_THINKING_LEVELS;
  const thinkingOptions = useMemo(
    () => levels.map((level) => ({ value: level, label: THINKING_LABELS[level] ?? level })),
    [levels],
  );

  const displayName = resolveDisplayName(models, current);
  const thinkingLabel =
    thinkingLevel === null ? null : (THINKING_LABELS[thinkingLevel] ?? thinkingLevel);

  return (
    <Flexbox horizontal align="center" gap={2} style={{ height: 28, minWidth: 0, maxWidth: '100%' }}>
      <Select
        size="small"
        variant="borderless"
        value={current === null ? undefined : modelSelectionKey(current)}
        onChange={(value: string) => {
          const selection = parseModelSelectionKey(value);
          if (selection !== null) onPickModel(selection);
        }}
        options={modelGroups}
        placeholder="选择模型"
        disabled={disabled}
        loading={loading}
        showSearch={{ filterOption: filterModelOption }}
        popupMatchSelectWidth={360}
        labelRender={() => displayName}
        notFoundContent={
          <Text fontSize={12} type="secondary" style={{ padding: 4 }}>
            {models.length === 0 ? '暂无可用模型' : '没有匹配的模型'}
          </Text>
        }
        style={{ minWidth: 92, maxWidth: 220 }}
      />

      <Select
        size="small"
        variant="borderless"
        value={thinkingLevel ?? undefined}
        onChange={(value: PiThinkingLevel) => onPickThinking(value)}
        options={[{ label: '思考等级', options: thinkingOptions }]}
        placeholder="思考等级"
        disabled={disabled}
        popupMatchSelectWidth={140}
        labelRender={() => thinkingLabel}
        styles={{
          root: {
            background: token.colorFillQuaternary,
            borderRadius: 999,
            paddingInline: 8,
          },
        }}
        style={{ width: 86 }}
      />

      <ActionIcon icon={Settings2} size="small" title="模型库" onClick={onOpenBrowser} />
    </Flexbox>
  );
}

/* ------------------------------------------------------- type-level smoke check */

/**
 * Not shipped behaviour, only intent: if this sample stops compiling, the public
 * prop contract changed. Kept as executable documentation in place of a test rig.
 */
const modelPickerPropsSample: ModelPickerProps = {
  models: [],
  current: null,
  thinkingLevels: [],
  thinkingLevel: null,
  onPickModel: () => {},
  onPickThinking: () => {},
  onOpenBrowser: () => {},
};

export type ModelPickerPropsAssertion = typeof modelPickerPropsSample;
