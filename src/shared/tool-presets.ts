/**
 * Tool presets — what this app calls a permission mode, matching pi-web's model
 * exactly (`lib/tool-presets.ts` there).
 *
 * pi has no approval layer: a tool the model calls simply runs. What pi does have
 * is a per-session **tool allowlist** (`setActiveToolsByName`, and the
 * `defaultTools` setting), so "permission" here means which tools exist at all —
 * the same thing pi-web exposes. The tier labels are mode names, not a security
 * guarantee: there is no approval or sandbox layer underneath them. An earlier
 * attempt in this repo asked the user to approve individual calls through an
 * extension; that invented a capability pi does not offer and ignored the one it
 * does.
 *
 * The menu shows three permission tiers, in escalation order (read-only →
 * default → full), after ZCode's access-mode menu: one shield glyph per tier,
 * `shield-check` for the cautious one up to `shield-alert` for the top tier.
 * The four underlying presets are still pi-web's, including its treatment of
 * `powershell` as the Windows spelling of `bash` when a preset is detected from
 * a live tool list.
 *
 * `none` ("纯对话") is no longer a menu entry, but it stays a real value: the
 * type keeps it, sessions recorded before the regroup still carry it, and
 * `presetFromToolNames([])` still reports it. `toolPresetOption` therefore keeps
 * a legacy display entry for it so a restored transcript renders its chip
 * honestly instead of pretending to be one of the three tiers.
 */

export const TOOL_PRESET_VALUES = ['none', 'read-only', 'default', 'full'] as const;
export type ToolPreset = (typeof TOOL_PRESET_VALUES)[number];

export const PRESET_NONE: string[] = [];
export const PRESET_READ_ONLY: string[] = ['read', 'grep', 'find', 'ls'];
export const PRESET_DEFAULT: string[] = ['read', 'bash', 'edit', 'write'];
export const PRESET_FULL: string[] = ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'];

/** Every builtin tool name any preset may mention. */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([...PRESET_FULL, 'powershell']);

/**
 * Which shield glyph a tier renders with. Keys, not components — this module is
 * shared with the server, so the iconKey → component map lives in the UI.
 */
export type ToolPresetIconKey = 'shield-check' | 'shield-pen' | 'shield-alert' | 'shield-off';

export interface ToolPresetOption {
  id: ToolPreset;
  iconKey: ToolPresetIconKey;
  label: string;
  hint: string;
}

/**
 * The three menu tiers, in escalation order.
 *
 * `shield-pen` is hand-drawn in `src/ui/primitives/icons` — lucide-react has
 * ShieldCheck and ShieldAlert but no pen-inside-shield glyph. The hint is the
 * tier's actual tool list: that list is the only real difference between tiers.
 */
export const TOOL_PRESET_OPTIONS: readonly ToolPresetOption[] = [
  { id: 'read-only', iconKey: 'shield-check', label: '仅可查看', hint: 'read / grep / find / ls' },
  { id: 'default', iconKey: 'shield-pen', label: '工作区内修改', hint: 'read / bash / edit / write' },
  { id: 'full', iconKey: 'shield-alert', label: '完全权限', hint: '工作区内修改 + grep / find / ls' },
];

/**
 * Legacy display entry for `none`. It left the menu, but old session records and
 * empty tool lists still mean it — this entry exists only so `toolPresetOption`
 * can render those honestly (chip reads「纯对话」, not one of the three tiers).
 */
const LEGACY_NONE_OPTION: ToolPresetOption = {
  id: 'none',
  iconKey: 'shield-off',
  label: '纯对话',
  hint: '不启用任何工具，只聊天',
};

export function toolPresetOption(preset: ToolPreset): ToolPresetOption {
  const listed = TOOL_PRESET_OPTIONS.find((option) => option.id === preset);
  if (listed) return listed;
  if (preset === 'none') return LEGACY_NONE_OPTION;
  // A value that slipped past the type (tampered storage, old server payload)
  // falls back to the default tier, resolved explicitly by id — never by array
  // index, which is how the pre-regroup `?? TOOL_PRESET_OPTIONS[3]` could hand
  // back the wrong tier after the list is reordered or shortened.
  return TOOL_PRESET_OPTIONS.find((option) => option.id === 'default')!;
}

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === 'string' && (TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

/** The preset a live tool list corresponds to, or `default` when it matches none. */
export function presetFromToolNames(toolNames: readonly string[]): ToolPreset {
  if (toolNames.length === 0) return 'none';
  const active = toolNames
    .map((name) => (name === 'powershell' ? 'bash' : name))
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(',');
  if (active === [...PRESET_READ_ONLY].sort().join(',')) return 'read-only';
  if (active === [...PRESET_DEFAULT].sort().join(',')) return 'default';
  if (active === [...PRESET_FULL].sort().join(',')) return 'full';
  return 'default';
}

/** The builtin tool names one preset selects. */
export function toolNamesForPreset(preset: ToolPreset): string[] {
  switch (preset) {
    case 'none':
      return [...PRESET_NONE];
    case 'read-only':
      return [...PRESET_READ_ONLY];
    case 'full':
      return [...PRESET_FULL];
    default:
      return [...PRESET_DEFAULT];
  }
}
