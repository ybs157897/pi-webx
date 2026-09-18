import { theme } from 'antd';
import type { ReactNode } from 'react';

import { IconChevronDownOutline14 } from '../ui/primitives/index.ts';

/**
 * The leading mark of a compact flow row — dsh's `DisclosureRow` / `ToolRow`
 * shape, taken from the harness it was vendored from: a 16px box holding the
 * row's own 14px glyph, which fades out for a chevron while the row is hovered
 * (or once it is open).
 *
 * That is why a transcript at rest shows no arrow at all: the chevron is the
 * hover affordance, not decoration. The two glyphs occupy the same box, so the
 * label never shifts when the pointer arrives.
 */
export function LeadingGlyph({ icon, swap, className }: {
  /** The row's own glyph, already sized (14px in a 16px box). */
  icon: ReactNode;
  /** Show the chevron instead: the row is hovered or expanded. */
  swap: boolean;
  className?: string | undefined;
}) {
  const { token } = theme.useToken();

  const layer = (visible: boolean): React.CSSProperties => ({
    position: 'absolute',
    inset: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: visible ? 1 : 0,
    transition: 'opacity 100ms ease',
  });

  return (
    <span
      className={className}
      style={{
        position: 'relative',
        flex: 'none',
        width: 16,
        height: 16,
        color: token.colorTextTertiary,
      }}
    >
      <span style={layer(!swap)}>{icon}</span>
      <span style={layer(swap)}>
        <IconChevronDownOutline14 />
      </span>
    </span>
  );
}
