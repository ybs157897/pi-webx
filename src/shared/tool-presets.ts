/**
 * Tool presets — what this app calls a permission mode, matching pi-web's model
 * exactly (`lib/tool-presets.ts` there).
 *
 * pi has no approval layer: a tool the model calls simply runs. What pi does have
 * is a per-session **tool allowlist** (`setActiveToolsByName`, and the
 * `defaultTools` setting), so "permission" here means which tools exist at all —
 * the same thing pi-web exposes. An earlier attempt in this repo asked the user to
 * approve individual calls through an extension; that invented a capability pi
 * does not offer and ignored the one it does.
 *
 * The four presets are pi-web's, including its treatment of `powershell` as the
 * Windows spelling of `bash` when a preset is detected from a live tool list.
 */

export const TOOL_PRESET_VALUES = ['none', 'read-only', 'default', 'full'] as const;
export type ToolPreset = (typeof TOOL_PRESET_VALUES)[number];

export const PRESET_NONE: string[] = [];
export const PRESET_READ_ONLY: string[] = ['read', 'grep', 'find', 'ls'];
export const PRESET_DEFAULT: string[] = ['read', 'bash', 'edit', 'write'];
export const PRESET_FULL: string[] = ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'];

/** Every builtin tool name any preset may mention. */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([...PRESET_FULL, 'powershell']);

export interface ToolPresetOption {
  id: ToolPreset;
  label: string;
  hint: string;
}

/**
 * Presentation for each preset.
 *
 * `none` is pi-web's "chat only": nothing is enabled, not even extension tools,
 * which is why it reads as a distinct mode rather than as the narrowest preset.
 */
export const TOOL_PRESET_OPTIONS: readonly ToolPresetOption[] = [
  { id: 'none', label: '纯对话', hint: '不启用任何工具，只聊天' },
  { id: 'read-only', label: '只读', hint: 'read / grep / find / ls' },
  { id: 'default', label: '默认', hint: 'read / bash / edit / write' },
  { id: 'full', label: '完全', hint: '默认 + grep / find / ls' },
];

export function toolPresetOption(preset: ToolPreset): ToolPresetOption {
  return TOOL_PRESET_OPTIONS.find((option) => option.id === preset) ?? TOOL_PRESET_OPTIONS[3]!;
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
