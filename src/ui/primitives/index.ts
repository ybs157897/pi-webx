/**
 * Vendored from deepseek-harness's `@deepseek-ai/dsh-client-ui-primitives`
 * (same figma source, same CSS): the small, self-contained UI kit the
 * dsh-style surfaces (sidebar, settings) are built from. CSS Modules and the
 * `--dsw-*` design tokens under `src/ui/theme/` do the styling.
 */
export { Menu } from './Menu.tsx'
export type { MenuEntry, MenuItem, MenuLabel, MenuSeparator } from './Menu.tsx'
export { Modal } from './Modal.tsx'
export { HoverCard } from './HoverCard.tsx'
export { StateDot } from './StateDot.tsx'
export type { StateDotState } from './StateDot.tsx'
export { Tooltip } from './Tooltip.tsx'
export { Button } from './Button.tsx'
export { relativeTime } from './relative-time.ts'
export type { RelativeTime, RelativeTimeUnit } from './relative-time.ts'
export { writeClipboard } from './clipboard.ts'
export * from './icons/index.tsx'
