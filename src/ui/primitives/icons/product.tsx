/**
 * Hand-authored product glyphs: the permission shield family plus secret-field affordances.
 * Split out of index.tsx as a mechanical move: glyph bodies are byte-for-byte
 * the originals, and index.tsx re-exports every one of them.
 */

import type { IconProps } from './props.ts'

/**
 * The permission shield contour on the 16 grid (design set 1556), stroked at
 * {@link SHIELD_OUTLINE_STROKE}. The composer's permission selector composes
 * its mode marks (check, pencil, exclamation) over this same path inside one
 * svg, so the geometry lives here once.
 */
export const SHIELD_OUTLINE_PATH = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z'

/** Stroke width of {@link SHIELD_OUTLINE_PATH}. */
export const SHIELD_OUTLINE_STROKE = '1.31831'

/** Permission row glyph of the composer menu: the shield contour alone, without a mode mark. */
export const IconShieldOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth={SHIELD_OUTLINE_STROKE} strokeLinejoin="round" />
  </svg>
)

/** Eye — reveals a write-only secret field (hand-authored product glyph). */
export const IconEyeOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 3.15c3.09 0 5.68 2.24 6.71 4.34.19.38.19.64 0 1.02-1.03 2.1-3.62 4.34-6.71 4.34S2.32 10.61 1.29 8.51c-.19-.38-.19-.64 0-1.02C2.32 5.39 4.91 3.15 8 3.15Zm0 1.3c-2.35 0-4.42 1.7-5.32 3.55.9 1.85 2.97 3.55 5.32 3.55s4.42-1.7 5.32-3.55C12.42 6.15 10.35 4.45 8 4.45Z"
      fill="currentColor"
    />
    <path
      d="M8 5.95a2.05 2.05 0 1 1 0 4.1 2.05 2.05 0 0 1 0-4.1Z"
      fill="currentColor"
    />
  </svg>
)

/** Eye with a slash — hides a revealed secret (hand-authored product glyph). */
export const IconEyeOffOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 3.15c3.09 0 5.68 2.24 6.71 4.34.19.38.19.64 0 1.02a9.26 9.26 0 0 1-1.6 2.31l-.92-.92c.5-.5.93-1.05 1.25-1.6-.9-1.85-2.97-3.55-5.32-3.55-.5 0-.98.08-1.43.21l-1-1c.73-.5 1.58-.81 2.31-.81Z"
      fill="currentColor"
    />
    <path
      d="M12.03 12.03a9.2 9.2 0 0 1-4.03 1.32c-3.09 0-5.68-2.24-6.71-4.34-.19-.38-.19-.64 0-1.02a9.6 9.6 0 0 1 2.4-3.02l1.6 1.6a2.05 2.05 0 0 0 2.72 2.72l1.32 1.32a2.05 2.05 0 0 1-2.44-.4l-.83-.84c-.4-.4-.66-.94-.66-1.54 0-.27.05-.53.15-.76L2.9 4.42A8.3 8.3 0 0 0 1.29 7.49c.9 1.85 2.97 3.55 5.32 3.55 1.2 0 2.3-.44 3.2-1.08l.92.92c-.63.5-1.36.88-2.16 1.1Z"
      fill="currentColor"
    />
    <path
      d="M2.16 1.28l12.6 12.6-.92.92-12.6-12.6.92-.92Z"
      fill="currentColor"
    />
  </svg>
)

/**
 * Padlock — marks a field whose value the form cannot change (hand-authored
 * product glyph, traced from the reference's locked 输入类型 chip: an open
 * shackle over a rounded body with a keyhole dot).
 */
export const IconLockOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M5.7 7.1V5.4a2.3 2.3 0 0 1 4.6 0v1.7"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <rect
      x="4.1"
      y="7.1"
      width="7.8"
      height="5.6"
      rx="1.4"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <circle cx="8" cy="9.9" r="0.85" fill="currentColor" />
  </svg>
)

/**
 * Shield + pen — the workspace-write tool tier in the composer's permission
 * menu (hand-authored product glyph; lucide-react 0.562 ships ShieldCheck /
 * ShieldAlert but no pen-inside-shield, and an unrelated stand-in would break
 * the one-shield-per-tier language). The outline traces lucide's Shield scaled
 * to the 16 grid; the pen is a small diagonal pencil inside it.
 */
export const IconShieldPenOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M13.33 8.67c0 3.33-2.33 5-5.11 5.97a.67.67 0 0 1-.45-.01C5 13.67 2.67 12 2.67 8.67V4a.67.67 0 0 1 .67-.67c1.33 0 3-.8 4.16-1.81a.78.78 0 0 1 1.01 0C9.67 2.54 11.33 3.33 12.67 3.33a.67.67 0 0 1 .66.67z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <path
      d="M10.6 5.6 11.3 6.3 9.2 8.4 8.1 8.8 8.5 7.7z"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
  </svg>
)
