/**
 * Composer-bar model and reasoning-effort controls.
 *
 * They were one cascading menu: a `模型` / `思考` root that drilled into two
 * panes, which hid the effort until the model menu was open. They are two
 * independent decisions — which model, and how hard it thinks — so they are two
 * pickers side by side here, each opening its own list, with the effort wearing
 * its own glyph.
 *
 * Purely presentational — the parent keeps ownership of session state and every
 * change is reported through props.
 */

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { Empty, Popover, theme } from 'antd';
import { Brain, Check, ChevronDown } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { THINKING_LABELS } from '../lib/format';
import { offeredThinkingLevels } from '../lib/modelCatalog';
import type { PiModel, PiThinkingLevel } from '../shared/protocol';

/* ------------------------------------------------------------------ selection */

/** A model addressed the way pi's RPC addresses it: provider + model id. */
export interface ModelSelection {
  provider: string;
  id: string;
}

export interface ModelSelectProps {
  models: PiModel[];
  /** Provider display names, keyed by provider id, for the group headers. */
  labels?: Record<string, string> | undefined;
  current: ModelSelection | null;
  disabled?: boolean;
  onPick: (selection: ModelSelection) => void;
}

export interface ThinkingSelectProps {
  /** Levels the running model accepts, as pi reports them. */
  thinkingLevels: PiThinkingLevel[];
  /** The level chosen for this model; `null` means nothing was chosen. */
  thinkingLevel: PiThinkingLevel | null;
  /**
   * The level actually in force (the choice, else pi's global default). Only the
   * trigger reads it: the pane must mark the *choice*, so that the `默认` entry is
   * both markable and true.
   */
  effectiveThinkingLevel?: PiThinkingLevel | null | undefined;
  disabled?: boolean;
  /** `null` clears the remembered level, matching dsh's `默认` entry. */
  onPick: (level: PiThinkingLevel | null) => void;
}

/* --------------------------------------------------------------------- layout */

const MENU_WIDTH = 320;
const LIST_MAX_HEIGHT = 280;
const TRIGGER_HEIGHT = 28;

/* -------------------------------------------------------------------- helpers */

function modelLabel(model: PiModel): string {
  return model.name || model.id;
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

/** The three stops, or the ones pi reported that fall inside them. */
function resolveLevels(levels: PiThinkingLevel[]): readonly PiThinkingLevel[] {
  return offeredThinkingLevels(levels);
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

/** The pane's own heading: one word, no drill-in to come back from. */
function PaneTitle({ text }: { text: string }) {
  return (
    <Flexbox horizontal align="center" paddingBlock={6} paddingInline={10}>
      <Text as="span" fontSize={12} type="secondary">
        {text}
      </Text>
    </Flexbox>
  );
}

function EmptyPane({ description }: { description: string }) {
  return (
    <Flexbox horizontal align="center" justify="center" style={{ padding: '32px 0' }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />
    </Flexbox>
  );
}

interface PickerShellProps {
  /** Accessible name of the trigger. */
  ariaLabel: string;
  /** Leading glyph — the effort pill wears a brain; the model pill none. */
  icon?: ReactNode;
  label: string;
  /** No choice made yet: the label reads as a placeholder, not as state. */
  placeholder?: boolean;
  disabled: boolean;
  /** Pane body; `close` dismisses the popover from a selection. */
  content: (close: () => void) => ReactNode;
}

/** Pill trigger + borderless popover, shared by both pickers. */
function PickerShell({ ariaLabel, icon, label, placeholder = false, disabled, content }: PickerShellProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  const close = (): void => { setOpen(false); };

  const triggerStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: TRIGGER_HEIGHT,
    maxWidth: 260,
    minWidth: 0,
    paddingInline: 8,
    borderStyle: 'none',
    borderRadius: 999,
    background: open || hovered ? token.colorFillTertiary : 'transparent',
    color: placeholder ? token.colorTextSecondary : token.colorText,
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: '20px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background 0.15s ease',
  };

  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={false}
      destroyOnHidden
      open={open && !disabled}
      onOpenChange={(next) => { if (!disabled) setOpen(next); }}
      content={(
        <div
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
          }}
        >
          {content(close)}
        </div>
      )}
      styles={{ container: { padding: 0 }, content: { padding: 0 } }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open && !disabled}
        aria-label={ariaLabel}
        onMouseEnter={() => { setHovered(true); }}
        onMouseLeave={() => { setHovered(false); }}
        style={triggerStyle}
      >
        {icon}
        <Text
          as="span"
          ellipsis
          fontSize={13}
          type={placeholder ? 'secondary' : undefined}
          style={{ minWidth: 0, maxWidth: 190 }}
        >
          {label}
        </Text>
        <Icon icon={ChevronDown} size={14} style={{ flexShrink: 0, opacity: 0.55 }} />
      </button>
    </Popover>
  );
}

/* ------------------------------------------------------------------ components */

export function ModelSelect({ models, labels, current, disabled = false, onPick }: ModelSelectProps) {
  const { token } = theme.useToken();
  const displayName = resolveDisplayName(models, current);

  // Groups keep the order the catalog delivered — the bridge already puts the
  // usable providers first — and models keep the runtime's own order. dsh's
  // picker does the same: its groups read DeepSeek, DeepSeek (Vision), OpenCode
  // Go…, which is the order the profiles were composed in, not alphabetical.
  const groups = useMemo(() => {
    const byProvider = new Map<string, PiModel[]>();
    for (const model of models) {
      const bucket = byProvider.get(model.provider);
      if (bucket) bucket.push(model);
      else byProvider.set(model.provider, [model]);
    }
    // Provider labels come from the catalog when the caller supplies groups
    // (Composer passes the flattened models, so the id is the fallback here).
    return [...byProvider.entries()].map(([provider, bucket]) => ({
      provider,
      label: labels?.[provider] ?? provider,
      models: bucket,
    }));
  }, [labels, models]);

  return (
    <PickerShell
      ariaLabel={displayName === null ? '选择模型' : `当前模型 ${displayName}`}
      label={displayName ?? '选择模型'}
      placeholder={displayName === null}
      disabled={disabled}
      content={(close) => (
        <Flexbox direction="vertical" style={{ width: MENU_WIDTH }}>
          <PaneTitle text="选择模型" />

          <div
            style={{
              maxHeight: LIST_MAX_HEIGHT,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              padding: '0 6px 6px',
            }}
          >
            {models.length === 0 ? (
              <EmptyPane description="暂无可用模型" />
            ) : (
              groups.map((group) => (
                <div key={group.provider}>
                  {/* dsh's group headers are the provider name alone: no count, no
                      capability tags. The catalog is already scoped to what this
                      deployment can run, so a note about unusable providers would
                      have nothing to say. */}
                  <Flexbox horizontal align="center" gap={6} style={{ padding: '6px 8px 2px' }}>
                    <Text as="span" fontSize={11} type="secondary" ellipsis style={{ minWidth: 0 }}>
                      {group.label}
                    </Text>
                  </Flexbox>

                  {group.models.map((model) => {
                    const active = isCurrentModel(current, model);
                    return (
                      <MenuRow
                        key={`${model.provider}/${model.id}`}
                        highlighted={active}
                        onClick={() => {
                          onPick({ provider: model.provider, id: model.id });
                          close();
                        }}
                      >
                        <Text as="span" ellipsis fontSize={13} style={{ flex: 1, minWidth: 0 }}>
                          {modelLabel(model)}
                        </Text>
                        {/* dsh marks the running model with a filled dot at the end of
                            the row; the row itself carries nothing else. */}
                        {active && (
                          <span
                            aria-hidden="true"
                            style={{
                              flexShrink: 0,
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              background: token.colorText,
                            }}
                          />
                        )}
                      </MenuRow>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </Flexbox>
      )}
    />
  );
}

export function ThinkingSelect({
  thinkingLevels,
  thinkingLevel,
  effectiveThinkingLevel,
  disabled = false,
  onPick,
}: ThinkingSelectProps) {
  const { token } = theme.useToken();
  const levels = resolveLevels(thinkingLevels);
  // No levels means the model cannot reason at all, which is a different state
  // from "nothing chosen yet": the trigger says so and the pane explains it,
  // rather than listing entries pi would silently refuse.
  const unavailable = levels.length === 0;

  // The trigger reports what is in force — the choice, else pi's own default —
  // because that is the fact a reader wants at a glance; the pane is where the
  // *choice* is marked, including the `默认` row that means "nothing chosen".
  const reported = effectiveThinkingLevel === undefined ? thinkingLevel : effectiveThinkingLevel;
  const label = unavailable ? '不支持' : reported === null ? '默认' : THINKING_LABELS[reported];

  return (
    <PickerShell
      ariaLabel={unavailable ? '推理等级：当前模型不支持' : `推理等级：${label}`}
      icon={<Brain size={13} style={{ flexShrink: 0, opacity: 0.75 }} />}
      label={label}
      placeholder={unavailable}
      disabled={disabled}
      content={(close) => (
        <Flexbox direction="vertical" style={{ width: MENU_WIDTH }}>
          <PaneTitle text="推理等级" />

          {unavailable ? (
            <Flexbox gap={4} style={{ padding: '0 10px 8px' }}>
              {/* dsh's own copy for this state (`empty.efforts`): the model is
                  the authority on the vocabulary, so the surface states the
                  absence instead of offering levels it would refuse. */}
              <Text as="span" fontSize={13} type="secondary">
                当前模型不提供推理等级
              </Text>
              <Text as="span" fontSize={12} type="secondary">
                换一个支持推理的模型后可选
              </Text>
            </Flexbox>
          ) : (
            <Flexbox direction="vertical" gap={2} style={{ padding: '0 6px 6px' }}>
              {/* dsh lists a `默认` entry first for "no effort chosen — the model's
                  provider decides", then the model's own advertised levels, each as a
                  friendly label with the current one ticked. No raw level ids. */}
              <MenuRow
                highlighted={thinkingLevel === null}
                onClick={() => {
                  onPick(null);
                  close();
                }}
              >
                <Text as="span" fontSize={13} style={{ flex: 1, minWidth: 0 }}>
                  默认
                </Text>
                {thinkingLevel === null && (
                  <Icon icon={Check} size={14} style={{ color: token.colorPrimary }} />
                )}
              </MenuRow>
              {levels.map((level) => {
                const active = thinkingLevel === level;
                return (
                  <MenuRow
                    key={level}
                    highlighted={active}
                    onClick={() => {
                      onPick(level);
                      close();
                    }}
                  >
                    <Text as="span" fontSize={13} style={{ flex: 1, minWidth: 0 }}>
                      {THINKING_LABELS[level]}
                    </Text>
                    {active && <Icon icon={Check} size={14} style={{ color: token.colorPrimary }} />}
                  </MenuRow>
                );
              })}
            </Flexbox>
          )}
        </Flexbox>
      )}
    />
  );
}
