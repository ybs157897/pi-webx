/**
 * Composer-bar model control, third iteration: a cascading two-level menu.
 *
 * Replaces V2's two-pane popover with the deepseek-harness `ModelSelect` shape —
 * a two-row root (`模型` / `思考`) where each row drills into a list pane and a
 * back affordance returns to the root. The model pane groups the catalogue by
 * provider and carries its own search box; the thinking pane lists the levels
 * pi accepts.
 *
 * Purely presentational — the parent keeps ownership of session state and every
 * change is reported through props.
 */

import { Flexbox, Icon, Tag as LobeTag, Text } from '@lobehub/ui';
import { Empty, Input, Popover, theme } from 'antd';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { THINKING_LABELS, formatTokens } from '../lib/format';
import { PI_THINKING_LEVELS, type PiModel, type PiThinkingLevel } from '../shared/protocol';

/* ------------------------------------------------------------------ selection */

/** A model addressed the way pi's RPC addresses it: provider + model id. */
export interface ModelSelection {
  provider: string;
  id: string;
}

export interface ModelSelectV3Props {
  models: PiModel[];
  current: ModelSelection | null;
  thinkingLevels: PiThinkingLevel[];
  thinkingLevel: PiThinkingLevel | null;
  disabled?: boolean;
  onPick: (selection: ModelSelection) => void;
  onPickThinking: (level: PiThinkingLevel) => void;
}

/* --------------------------------------------------------------------- layout */

/** The root menu and its two drill-ins; only one is mounted at a time. */
type Pane = 'root' | 'model' | 'thinking';

const MENU_WIDTH = 320;
const LIST_MAX_HEIGHT = 280;
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

/** Levels pi reported, or the protocol list while that request is still in flight. */
function resolveLevels(levels: PiThinkingLevel[]): readonly PiThinkingLevel[] {
  return levels.length > 0 ? levels : PI_THINKING_LEVELS;
}

/* ----------------------------------------------------------------- primitives */

interface MenuRowProps {
  onClick: () => void;
  /** Soft primary background; marks the running model / level. */
  highlighted?: boolean;
  children: ReactNode;
}

/** One clickable menu line: hover tint, selected tint, no chrome of its own. */
function MenuRow({ onClick, highlighted = false, children }: MenuRowProps) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      aria-current={highlighted ? 'true' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '5px 8px',
        borderStyle: 'none',
        borderRadius: token.borderRadius,
        background: highlighted
          ? token.colorPrimaryBg
          : hovered
            ? token.colorFillQuaternary
            : 'transparent',
        color: 'inherit',
        fontFamily: 'inherit',
        textAlign: 'start',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

/** Back affordance + pane title for the drilled-in panes. */
function PaneHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);

  return (
    <Flexbox horizontal align="center" gap={4} paddingBlock={5} paddingInline={6}>
      <button
        type="button"
        onClick={onBack}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          padding: '2px 6px 2px 2px',
          borderStyle: 'none',
          borderRadius: token.borderRadius,
          background: hovered ? token.colorFillQuaternary : 'transparent',
          color: token.colorTextSecondary,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        <Icon icon={ChevronLeft} size={14} />
        <Text as="span" fontSize={12} style={{ color: 'inherit' }}>
          返回
        </Text>
      </button>
      <Text as="span" fontSize={12} type="secondary" style={{ marginInlineStart: 'auto' }}>
        {title}
      </Text>
    </Flexbox>
  );
}

function EmptyState({ description }: { description: string }) {
  return (
    <Flexbox horizontal align="center" justify="center" style={{ padding: '32px 0' }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />
    </Flexbox>
  );
}

/* ------------------------------------------------------------------ component */

export function ModelSelectV3({
  models,
  current,
  thinkingLevels,
  thinkingLevel,
  disabled = false,
  onPick,
  onPickThinking,
}: ModelSelectV3Props) {
  const { token } = theme.useToken();

  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>('root');
  const [query, setQuery] = useState('');
  const [triggerHovered, setTriggerHovered] = useState(false);

  const displayName = resolveDisplayName(models, current);
  const thinkingLabel = thinkingLevel !== null ? THINKING_LABELS[thinkingLevel] : null;
  // The trigger stays terse: `关闭` is the default and adds no information there.
  const thinkingSuffix = thinkingLevel !== null && thinkingLevel !== 'off' ? thinkingLabel : null;

  const levels = resolveLevels(thinkingLevels);

  // Search narrows the catalogue; the provider grouping is derived from the same
  // narrowed list, so headers and counts follow the query.
  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return models;
    return models.filter((model) => matchesQuery(model, needle));
  }, [models, query]);

  const groups = useMemo(() => {
    const byProvider = new Map<string, PiModel[]>();
    for (const model of filteredModels) {
      const bucket = byProvider.get(model.provider);
      if (bucket) bucket.push(model);
      else byProvider.set(model.provider, [model]);
    }
    return [...byProvider.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, bucket]) => ({
        provider,
        models: [...bucket].sort((left, right) =>
          modelLabel(left).localeCompare(modelLabel(right)),
        ),
      }));
  }, [filteredModels]);

  const handleOpenChange = (next: boolean) => {
    if (disabled) return;
    if (next) {
      setQuery('');
      setPane('root');
    }
    setOpen(next);
  };

  const handlePick = (model: PiModel) => {
    onPick({ provider: model.provider, id: model.id });
    setOpen(false);
  };

  const handlePickThinking = (level: PiThinkingLevel) => {
    onPickThinking(level);
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
        style={{ minWidth: 0, maxWidth: 190 }}
      >
        {displayName ?? '选择模型'}
      </Text>
      {thinkingSuffix !== null && (
        <Text as="span" fontSize={12} type="secondary" style={{ flexShrink: 0 }}>
          · {thinkingSuffix}
        </Text>
      )}
      <Icon icon={ChevronDown} size={14} style={{ flexShrink: 0, opacity: 0.55 }} />
    </button>
  );

  /* -------------------------------------------------------------- menu panes */

  const rootPane = (
    <Flexbox direction="vertical" gap={2} padding={6} style={{ width: MENU_WIDTH }}>
      <MenuRow onClick={() => setPane('model')}>
        <Text as="span" fontSize={13} style={{ flexShrink: 0 }}>
          模型
        </Text>
        <Text
          as="span"
          ellipsis
          fontSize={13}
          type="secondary"
          style={{ flex: 1, minWidth: 0, textAlign: 'end' }}
        >
          {displayName ?? '未选择'}
        </Text>
        <Icon icon={ChevronRight} size={14} style={{ flexShrink: 0, opacity: 0.45 }} />
      </MenuRow>

      <MenuRow onClick={() => setPane('thinking')}>
        <Text as="span" fontSize={13} style={{ flexShrink: 0 }}>
          思考
        </Text>
        <Text
          as="span"
          ellipsis
          fontSize={13}
          type="secondary"
          style={{ flex: 1, minWidth: 0, textAlign: 'end' }}
        >
          {thinkingLabel ?? '未设置'}
        </Text>
        <Icon icon={ChevronRight} size={14} style={{ flexShrink: 0, opacity: 0.45 }} />
      </MenuRow>
    </Flexbox>
  );

  const modelPane = (
    <Flexbox direction="vertical" style={{ width: MENU_WIDTH }}>
      <PaneHeader title="选择模型" onBack={() => setPane('root')} />

      <Flexbox style={{ padding: '0 8px 8px' }}>
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

      <div
        style={{
          maxHeight: LIST_MAX_HEIGHT,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          padding: '0 6px 6px',
        }}
      >
        {models.length === 0 ? (
          <EmptyState description="暂无可用模型" />
        ) : groups.length === 0 ? (
          <EmptyState description="没有匹配的模型" />
        ) : (
          groups.map((group) => (
            <div key={group.provider}>
              <Flexbox
                horizontal
                align="center"
                justify="space-between"
                gap={6}
                style={{ padding: '6px 8px 2px' }}
              >
                <Text as="span" fontSize={11} type="secondary">
                  {group.provider}
                </Text>
                <Text as="span" fontSize={11} type="secondary" style={{ opacity: 0.6 }}>
                  {group.models.length}
                </Text>
              </Flexbox>

              {group.models.map((model) => {
                const currentModel = isCurrentModel(current, model);
                const context = contextLabel(model);
                return (
                  <MenuRow
                    key={`${model.provider}/${model.id}`}
                    highlighted={currentModel}
                    onClick={() => handlePick(model)}
                  >
                    <Flexbox flex={1} allowShrink gap={1} style={{ minWidth: 0 }}>
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
                        <LobeTag size="small" style={{ marginInlineEnd: 0 }}>
                          {context}
                        </LobeTag>
                      )}
                      {model.reasoning === true && (
                        <LobeTag size="small" color="purple" style={{ marginInlineEnd: 0 }}>
                          推理
                        </LobeTag>
                      )}
                      {supportsImageInput(model) && (
                        <LobeTag size="small" color="cyan" style={{ marginInlineEnd: 0 }}>
                          图像
                        </LobeTag>
                      )}
                      {currentModel && (
                        <Icon icon={Check} size={14} style={{ color: token.colorPrimary }} />
                      )}
                    </Flexbox>
                  </MenuRow>
                );
              })}
            </div>
          ))
        )}
      </div>
    </Flexbox>
  );

  const thinkingPane = (
    <Flexbox direction="vertical" style={{ width: MENU_WIDTH }}>
      <PaneHeader title="思考等级" onBack={() => setPane('root')} />

      <Flexbox direction="vertical" gap={2} style={{ padding: '0 6px 6px' }}>
        {levels.map((level) => {
          const active = thinkingLevel === level;
          return (
            <MenuRow key={level} highlighted={active} onClick={() => handlePickThinking(level)}>
              <Text as="span" fontSize={13} style={{ flex: 1, minWidth: 0 }}>
                {THINKING_LABELS[level]}
              </Text>
              <Text
                as="span"
                fontSize={11}
                type="secondary"
                style={{ flexShrink: 0, fontFamily: token.fontFamilyCode }}
              >
                {level}
              </Text>
              {active && <Icon icon={Check} size={14} style={{ color: token.colorPrimary }} />}
            </MenuRow>
          );
        })}
      </Flexbox>
    </Flexbox>
  );

  const content = (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      {pane === 'model' ? modelPane : pane === 'thinking' ? thinkingPane : rootPane}
    </div>
  );

  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={false}
      destroyOnHidden
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      content={content}
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
const modelSelectV3PropsSample: ModelSelectV3Props = {
  models: [],
  current: null,
  thinkingLevels: [],
  thinkingLevel: null,
  disabled: false,
  onPick: () => {},
  onPickThinking: () => {},
};

export type ModelSelectV3PropsAssertion = typeof modelSelectV3PropsSample;

const modelSelectV3UsageSample = (
  <ModelSelectV3
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
  />
);

export type ModelSelectV3UsageAssertion = typeof modelSelectV3UsageSample;
