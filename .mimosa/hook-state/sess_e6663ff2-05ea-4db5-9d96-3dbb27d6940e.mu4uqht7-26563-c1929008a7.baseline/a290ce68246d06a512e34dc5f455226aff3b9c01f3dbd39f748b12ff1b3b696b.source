/**
 * Composer-bar model control, second iteration: ONE unified picker instead of the
 * old pair of dropdowns plus the separate model browser.
 *
 * Closed: a single compact trigger (28px) showing the running model's display name,
 * a thinking-level pill, and a chevron. Open: a popover with a live search box, a
 * provider column, the selected provider's models, and the thinking-level control
 * in the footer next to the shortcut into the full model-config surface.
 *
 * Purely presentational — the parent keeps ownership of session state and every
 * change is reported through props.
 */

import { Flexbox, Icon, Tag as LobeTag, Text } from '@lobehub/ui';
import { Empty, Input, Popover, Segmented, Tag, theme } from 'antd';
import { ChevronsUpDown, Search, Settings2 } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';

import { THINKING_LABELS, formatTokens } from '../lib/format';
import { PI_THINKING_LEVELS, type PiModel, type PiThinkingLevel } from '../shared/protocol';

/* ------------------------------------------------------------------ selection */

/** A model addressed the way pi's RPC addresses it: provider + model id. */
export interface ModelSelection {
  provider: string;
  id: string;
}

export interface ModelPickerV2Props {
  models: PiModel[];
  current: ModelSelection | null;
  thinkingLevels: PiThinkingLevel[];
  thinkingLevel: PiThinkingLevel | null;
  disabled?: boolean;
  /** Fired when a model is picked. The popover closes on pick (thinking does not). */
  onPick: (selection: ModelSelection) => void;
  onPickThinking: (level: PiThinkingLevel) => void;
  /** Opens the full model-config surface. The link is hidden when omitted. */
  onOpenConfig?: () => void;
}

/* --------------------------------------------------------------------- layout */

const POPOVER_WIDTH = 640;
const PROVIDER_PANE_WIDTH = 150;
const PANE_HEIGHT = 320;
const TRIGGER_HEIGHT = 28;

/* -------------------------------------------------------------------- helpers */

function modelLabel(model: PiModel): string {
  return model.name || model.id;
}

/** Case-insensitive match over everything a user may remember about a model. */
function matchesQuery(model: PiModel, needle: string): boolean {
  if (needle.length === 0) return true;
  return `${modelLabel(model)} ${model.id} ${model.provider}`.toLowerCase().includes(needle);
}

function supportsImageInput(model: PiModel): boolean {
  return Array.isArray(model.input) && model.input.includes('image');
}

/** `128k`-style hint; `null` when pi reported nothing usable (never `NaN`). */
function contextLabel(model: PiModel): string | null {
  const contextWindow = model.contextWindow;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return formatTokens(contextWindow);
}

function isCurrentModel(current: ModelSelection | null, model: PiModel): boolean {
  return current !== null && current.provider === model.provider && current.id === model.id;
}

/**
 * `name || id` for the running model. `models` is scoped by pi and may not contain
 * the model a resumed session is running, so fall back to the raw `provider/id`;
 * `null` only when there is no selection at all (the trigger shows a placeholder).
 */
function resolveDisplayName(models: PiModel[], current: ModelSelection | null): string | null {
  if (current === null) return null;
  const match = models.find(
    (model) => model.provider === current.provider && model.id === current.id,
  );
  return match ? modelLabel(match) : `${current.provider}/${current.id}`;
}

/* ------------------------------------------------------------------ component */

export function ModelPickerV2({
  models,
  current,
  thinkingLevels,
  thinkingLevel,
  disabled = false,
  onPick,
  onPickThinking,
  onOpenConfig,
}: ModelPickerV2Props) {
  const { token } = theme.useToken();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Provider chosen in the left pane; `null` means "follow `current`". */
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [triggerHovered, setTriggerHovered] = useState(false);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [configHovered, setConfigHovered] = useState(false);

  // pi reports which levels it accepts; fall back to the protocol list so the
  // control is never empty while `get_available_thinking_levels` is in flight.
  const levels: readonly PiThinkingLevel[] =
    thinkingLevels.length > 0 ? thinkingLevels : PI_THINKING_LEVELS;

  const levelOptions = useMemo(
    () => levels.map((level) => ({ label: THINKING_LABELS[level] ?? level, value: level })),
    [levels],
  );

  // Search narrows the model list; the provider column is derived from the same
  // narrowed list, so both panes filter together and counts follow the query.
  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return models;
    return models.filter((model) => matchesQuery(model, needle));
  }, [models, query]);

  const providerEntries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of filteredModels) {
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, count]) => ({ id, count }));
  }, [filteredModels]);

  // Keep the user's pick while it is still visible; otherwise fall back to the
  // first provider (also covers `current.provider` not being in `models`).
  const activeProvider = useMemo(() => {
    if (
      selectedProvider !== null &&
      providerEntries.some((entry) => entry.id === selectedProvider)
    ) {
      return selectedProvider;
    }
    return providerEntries[0]?.id ?? null;
  }, [providerEntries, selectedProvider]);

  const visibleModels = useMemo(() => {
    if (activeProvider === null) return [];
    return filteredModels
      .filter((model) => model.provider === activeProvider)
      .sort((left, right) => modelLabel(left).localeCompare(modelLabel(right)));
  }, [filteredModels, activeProvider]);

  const displayName = resolveDisplayName(models, current);
  const thinkingLabel =
    thinkingLevel !== null && thinkingLevel !== 'off'
      ? (THINKING_LABELS[thinkingLevel] ?? thinkingLevel)
      : null;

  const handleOpenChange = (next: boolean) => {
    if (disabled) return;
    if (next) {
      setQuery('');
      setSelectedProvider(current?.provider ?? null);
    }
    setOpen(next);
  };

  // Default pick behaviour: apply and close. Thinking changes deliberately stay open.
  const handlePick = (model: PiModel) => {
    onPick({ provider: model.provider, id: model.id });
    setOpen(false);
  };

  /* ----------------------------------------------------------------- trigger */

  const triggerStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: TRIGGER_HEIGHT,
    maxWidth: 260,
    minWidth: 0,
    paddingInline: 8,
    borderStyle: 'none',
    borderRadius: 999,
    background: open || triggerHovered ? token.colorFillTertiary : 'transparent',
    color: token.colorText,
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: '20px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background 0.15s ease',
  };

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open && !disabled}
      aria-label={displayName === null ? '选择模型' : `当前模型 ${displayName}`}
      onMouseEnter={() => setTriggerHovered(true)}
      onMouseLeave={() => setTriggerHovered(false)}
      style={triggerStyle}
    >
      <Text
        as="span"
        ellipsis
        fontSize={13}
        type={displayName === null ? 'secondary' : undefined}
        style={{ minWidth: 0, maxWidth: 200 }}
      >
        {displayName ?? '选择模型'}
      </Text>
      {thinkingLabel !== null && (
        <LobeTag size="small" shape="round">
          {thinkingLabel}
        </LobeTag>
      )}
      <Icon icon={ChevronsUpDown} size={14} style={{ flexShrink: 0, opacity: 0.55 }} />
    </button>
  );

  /* -------------------------------------------------------------- popover body */

  const popoverBody = (
    <Flexbox style={{ width: POPOVER_WIDTH }} gap={0}>
      <Flexbox style={{ padding: 8 }}>
        <Input
          size="small"
          allowClear
          autoFocus
          placeholder="搜索模型…"
          prefix={<Icon icon={Search} size={14} style={{ opacity: 0.4 }} />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </Flexbox>

      {models.length === 0 ? (
        <Flexbox
          horizontal
          align="center"
          justify="center"
          style={{
            height: PANE_HEIGHT,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可用模型" />
        </Flexbox>
      ) : (
        <Flexbox
          horizontal
          align="stretch"
          style={{
            height: PANE_HEIGHT,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <div
            style={{
              width: PROVIDER_PANE_WIDTH,
              flexShrink: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              padding: 6,
              borderInlineEnd: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            {providerEntries.map((entry) => {
              const active = entry.id === activeProvider;
              const rowKey = `provider:${entry.id}`;
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedProvider(entry.id)}
                  onMouseEnter={() => setHoveredRow(rowKey)}
                  onMouseLeave={() => setHoveredRow((prev) => (prev === rowKey ? null : prev))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    width: '100%',
                    padding: '5px 8px',
                    borderStyle: 'none',
                    borderRadius: token.borderRadius,
                    background: active
                      ? token.colorFillSecondary
                      : hoveredRow === rowKey
                        ? token.colorFillQuaternary
                        : 'transparent',
                    color: 'inherit',
                    fontFamily: 'inherit',
                    textAlign: 'start',
                    cursor: 'pointer',
                  }}
                >
                  <Text
                    as="span"
                    ellipsis
                    fontSize={12.5}
                    type={active ? undefined : 'secondary'}
                    weight={active ? 600 : undefined}
                    style={{ minWidth: 0 }}
                  >
                    {entry.id}
                  </Text>
                  <Text as="span" fontSize={11} type="secondary" style={{ flexShrink: 0 }}>
                    {entry.count}
                  </Text>
                </button>
              );
            })}
          </div>

          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: 6 }}>
            {visibleModels.length === 0 ? (
              <Flexbox horizontal align="center" justify="center" style={{ height: '100%' }}>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的模型" />
              </Flexbox>
            ) : (
              visibleModels.map((model) => {
                const currentModel = isCurrentModel(current, model);
                const context = contextLabel(model);
                const rowKey = `model:${model.provider}/${model.id}`;
                return (
                  <button
                    key={`${model.provider}/${model.id}`}
                    type="button"
                    aria-current={currentModel}
                    onClick={() => handlePick(model)}
                    onMouseEnter={() => setHoveredRow(rowKey)}
                    onMouseLeave={() => setHoveredRow((prev) => (prev === rowKey ? null : prev))}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      width: '100%',
                      padding: '5px 8px',
                      borderStyle: 'none',
                      borderRadius: token.borderRadius,
                      background: currentModel
                        ? token.colorPrimaryBg
                        : hoveredRow === rowKey
                          ? token.colorFillQuaternary
                          : 'transparent',
                      color: 'inherit',
                      fontFamily: 'inherit',
                      textAlign: 'start',
                      cursor: 'pointer',
                    }}
                  >
                    <Flexbox flex={1} allowShrink gap={1}>
                      <Text as="span" ellipsis fontSize={13} style={{ minWidth: 0 }}>
                        {modelLabel(model)}
                      </Text>
                      <Text
                        as="span"
                        ellipsis
                        fontSize={11}
                        type="secondary"
                        style={{ minWidth: 0, fontFamily: token.fontFamilyCode }}
                      >
                        {model.id}
                      </Text>
                    </Flexbox>

                    <Flexbox horizontal align="center" gap={4} style={{ flexShrink: 0 }}>
                      {context !== null && (
                        <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0, paddingInline: 5 }}>
                          {context}
                        </Tag>
                      )}
                      {model.reasoning === true && (
                        <Tag color="purple" style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0, paddingInline: 5 }}>
                          推理
                        </Tag>
                      )}
                      {supportsImageInput(model) && (
                        <Tag color="cyan" style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0, paddingInline: 5 }}>
                          图像
                        </Tag>
                      )}
                    </Flexbox>
                  </button>
                );
              })
            )}
          </div>
        </Flexbox>
      )}

      <Flexbox
        horizontal
        align="center"
        justify="space-between"
        gap={8}
        style={{ padding: '6px 8px', borderTop: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Flexbox horizontal align="center" gap={6}>
          <Text as="span" fontSize={11} type="secondary">
            思考等级
          </Text>
          <Segmented<PiThinkingLevel>
            size="small"
            options={levelOptions}
            value={thinkingLevel ?? undefined}
            onChange={(level) => onPickThinking(level)}
          />
        </Flexbox>

        {onOpenConfig !== undefined && (
          <button
            type="button"
            onClick={onOpenConfig}
            onMouseEnter={() => setConfigHovered(true)}
            onMouseLeave={() => setConfigHovered(false)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 6px',
              borderStyle: 'none',
              borderRadius: token.borderRadius,
              background: configHovered ? token.colorFillQuaternary : 'transparent',
              color: token.colorPrimary,
              fontFamily: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            <Icon icon={Settings2} size={13} />
            <Text as="span" fontSize={12} style={{ color: 'inherit' }}>
              模型配置
            </Text>
          </button>
        )}
      </Flexbox>
    </Flexbox>
  );

  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={false}
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      content={popoverBody}
      styles={{ container: { padding: 0 }, content: { padding: 0 } }}
    >
      {trigger}
    </Popover>
  );
}

/* ------------------------------------------------------- usage + type assertions */

/**
 * Not shipped behaviour, only intent: if either sample stops compiling, the public
 * contract changed. Kept as executable documentation in place of a test rig.
 */
const modelPickerV2PropsSample: ModelPickerV2Props = {
  models: [],
  current: null,
  thinkingLevels: [],
  thinkingLevel: null,
  disabled: false,
  onPick: () => {},
  onPickThinking: () => {},
  onOpenConfig: () => {},
};

export type ModelPickerV2PropsAssertion = typeof modelPickerV2PropsSample;

const modelPickerV2UsageSample = (
  <ModelPickerV2
    models={[]}
    current={{ provider: 'anthropic', id: 'claude-sonnet-4-5' }}
    thinkingLevels={['off', 'low', 'high']}
    thinkingLevel="high"
    onPick={(selection: ModelSelection) => {
      void selection.provider;
    }}
    onPickThinking={(level: PiThinkingLevel) => {
      void level;
    }}
    onOpenConfig={() => {}}
  />
);

export type ModelPickerV2UsageAssertion = typeof modelPickerV2UsageSample;
