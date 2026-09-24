/**
 * The composer's tool-preset control — pi-web's permission model, in dsh's
 * location (the left of the composer row, where its access-mode chip sits).
 *
 * The menu lists the three permission tiers, each row a shield glyph + label +
 * a trailing Check on the active one — the access-mode menu shape ZCode uses,
 * and dsh's `PermissionSelect` exactly: one line per tier, no second line. The
 * tier's tool list stays in `shared/tool-presets.ts` (it is the data's own
 * description of a tier, and the server reads the same table), and it reaches
 * the user through the trigger's `title`, which is where dsh puts its preset
 * description too.
 *
 * A preset is a tool allowlist, not an approval prompt: pi has no approval
 * layer, and the thing it does have is the per-session tool set. This control is
 * the editor for that set, and its choice is recorded on the session itself —
 * see `server/tool-selection.ts`, which persists it as a versioned custom entry
 * so reopening a transcript restores the tools it was last run with.
 *
 * The browser preference (`pi-webx-tool-preset`) only decides what a *new* session
 * starts from, which is exactly the split pi-web makes between its
 * `pi-tool-preset` storage and each session's own record.
 */

import { Popover, theme } from 'antd';
import { useEffect, useState, type ComponentType } from 'react';
import { Check, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';

import { IconShieldPenOutline16 } from '../ui/primitives/icons';
import {
  isToolPreset,
  toolPresetOption,
  TOOL_PRESET_OPTIONS,
  type ToolPreset,
  type ToolPresetOption,
} from '../shared/tool-presets';

const STORAGE_KEY = 'pi-webx-tool-preset';

/**
 * One shield glyph per tier, resolved from the option's `iconKey` — this map is
 * the single id→icon decision point, so no call site re-derives it from ids.
 */
const TIER_ICONS: Record<ToolPresetOption['iconKey'], ComponentType<{ size?: number }>> = {
  'shield-check': ShieldCheck,
  'shield-pen': IconShieldPenOutline16,
  'shield-alert': ShieldAlert,
  // Legacy: 'none' left the menu but old session records still carry it.
  'shield-off': ShieldOff,
};

export function readToolPresetPreference(): ToolPreset {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isToolPreset(stored) ? stored : 'default';
  } catch {
    return 'default';
  }
}

function writeToolPresetPreference(preset: ToolPreset): void {
  try {
    localStorage.setItem(STORAGE_KEY, preset);
  } catch {
    // Browser storage is best-effort, as in pi-web.
  }
}

export interface ToolPresetSelectProps {
  disabled?: boolean;
  /**
   * The session's preset, when known. A resumed session reports the selection
   * from its own log, which overrides the browser preference.
   */
  current?: ToolPreset | null;
  /** Apply the preset to the active session; absent with no session to apply to. */
  onApply?: ((preset: ToolPreset) => void) | undefined;
}

export interface ToolPresetMenuProps {
  /** The tier in force: highlighted, and the one wearing the trailing Check. */
  shown: ToolPreset;
  /** Apply a tier — the trigger owns storage, the session write and closing. */
  onChoose: (preset: ToolPreset) => void;
  /** Undefined when there is no session yet to apply a tier to (footer note). */
  onApply?: ((preset: ToolPreset) => void) | undefined;
}

/**
 * The popover's content, on its own so it is exactly what the popover shows.
 *
 * It is exported for `scripts/check-tool-preset-menu.ts`: the overlay's content
 * is not in the SSR markup (antd only mounts it on open), and the thing worth
 * pinning here is the HTML of a menu row — one line, glyph + label + Check.
 * Open/close stays with the trigger; hover, the rows and the footer live here.
 */
export function ToolPresetMenu({ shown, onChoose, onApply }: ToolPresetMenuProps) {
  const { token } = theme.useToken();
  const [hoveredTier, setHoveredTier] = useState<ToolPreset | null>(null);

  return (
    <div style={{ width: 264 }}>
      {TOOL_PRESET_OPTIONS.map((entry) => {
        const TierIcon = TIER_ICONS[entry.iconKey];
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => { onChoose(entry.id); }}
            onMouseEnter={() => { setHoveredTier(entry.id); }}
            onMouseLeave={() => { setHoveredTier(null); }}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 8px',
              borderStyle: 'none',
              borderRadius: token.borderRadius,
              background: entry.id === shown
                ? token.colorPrimaryBg
                : hoveredTier === entry.id
                  ? token.colorFillTertiary
                  : 'transparent',
              color: 'inherit',
              fontFamily: 'inherit',
              textAlign: 'start',
              cursor: 'pointer',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <TierIcon size={14} />
              <span style={{ fontSize: 13, flex: 1 }}>{entry.label}</span>
              {entry.id === shown && (
                <Check size={14} style={{ color: token.colorPrimary, flexShrink: 0 }} />
              )}
            </span>
          </button>
        );
      })}
      {onApply === undefined && (
        <p style={{ margin: '4px 8px 0', fontSize: 11, color: token.colorTextQuaternary }}>
          发送第一条消息时按此预设创建会话
        </p>
      )}
    </div>
  );
}

export function ToolPresetSelect({ disabled = false, current = null, onApply }: ToolPresetSelectProps) {
  const { token } = theme.useToken();
  const [preferred, setPreferred] = useState<ToolPreset>(readToolPresetPreference);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  // A session that has recorded its own selection wins over the preference.
  useEffect(() => {
    if (current !== null) setPreferred(current);
  }, [current]);

  const shown = current ?? preferred;
  const option = toolPresetOption(shown);
  const ShownIcon = TIER_ICONS[option.iconKey];

  const choose = (next: ToolPreset): void => {
    setOpen(false);
    setPreferred(next);
    writeToolPresetPreference(next);
    onApply?.(next);
  };

  // The tier's tool list as the trigger's tooltip: dsh keeps its presets'
  // descriptions off the menu rows and on the trigger's `title` the same way.
  const content = <ToolPresetMenu shown={shown} onChoose={choose} onApply={onApply} />;

  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={false}
      destroyOnHidden
      open={open && !disabled}
      onOpenChange={(next) => { if (!disabled) setOpen(next); }}
      content={content}
      styles={{ container: { padding: 6 }, content: { padding: 0 } }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-label={`工具集，当前：${option.label}`}
        title={option.hint}
        onMouseEnter={() => { setHovered(true); }}
        onMouseLeave={() => { setHovered(false); }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 24,
          paddingInline: 8,
          borderStyle: 'none',
          borderRadius: 999,
          background: open || hovered ? token.colorFillTertiary : 'transparent',
          // 'none' warns because nothing is enabled; 'full' wears the same tint
          // on purpose — ZCode tints its top access-mode trigger too, so the
          // most permissive mode reads as the alert one at a glance. The tint
          // signals the mode, it is not a safety guarantee (pi has no approval
          // layer for the chip to stand in for).
          color: shown === 'none' || shown === 'full' ? token.colorWarning : token.colorTextSecondary,
          fontFamily: 'inherit',
          fontSize: 12,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <ShownIcon size={13} />
        {option.label}
      </button>
    </Popover>
  );
}
