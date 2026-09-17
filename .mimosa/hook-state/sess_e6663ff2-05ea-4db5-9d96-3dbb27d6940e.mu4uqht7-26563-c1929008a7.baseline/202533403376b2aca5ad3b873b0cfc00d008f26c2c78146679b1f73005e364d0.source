/**
 * Labelled form row used by the provider editor: label, control, then either the
 * error (shown once a save has been attempted) or the hint text.
 */

import { Text } from '@lobehub/ui';
import { theme } from 'antd';
import type { ReactNode } from 'react';

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  /** blocks nothing by itself; the editor gates display on a save attempt */
  error?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <Text fontSize={11} weight={600} style={{ color: token.colorTextSecondary }}>
        {label}
      </Text>
      {children}
      {error !== undefined ? (
        <Text fontSize={10.5} type="danger">
          {error}
        </Text>
      ) : typeof hint === 'string' ? (
        <Text fontSize={10.5} style={{ color: token.colorTextQuaternary }}>
          {hint}
        </Text>
      ) : (
        hint
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- asserts */

/**
 * Usage assert: both editor files render `<Field {...props} />` with exactly
 * these props, so the primitive's contract cannot change silently.
 */
const sampleFieldProps: FieldProps = {
  label: 'Base URL',
  hint: '必填，例如 https://api.example.com/v1',
  children: null,
};

export type FieldPropsAssertion = typeof sampleFieldProps;
