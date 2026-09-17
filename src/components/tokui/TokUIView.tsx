import { useEffect, useRef } from 'react';
import { TokUI } from '@jboltai/tokui';

export interface TokUIViewProps {
  /** TokUI bracket-DSL text */
  dsl: string;
  /** our theme name → tokui's `data-tokui-theme` */
  theme?: 'light' | 'dark';
  /** forwarded when a rendered button/form fires — maps to a pi message */
  onAction?: ((action: string) => void) | undefined;
}

function actionText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const record = data as Record<string, unknown>;
  for (const key of ['value', 'label', 'tt', 'title', 'text', 'name']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  // A form submit carries its fields; render them as a compact summary.
  const entries = Object.entries(record).filter(([, v]) => typeof v === 'string' && v.length > 0);
  return entries.map(([k, v]) => `· ${k}: ${String(v)}`).join('\n');
}

/**
 * Renders one TokUI DSL block into an empty dedicated container.
 * Nothing else may render children into that node (TokUI owns it).
 */
export function TokUIView({ dsl, theme, onAction }: TokUIViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const ui = new TokUI({
      container: node,
      theme: theme === 'dark' ? 'dark' : 'default',
      onEvent: (name, data) => {
        if (name !== 'click' && name !== 'submit' && name !== 'component') return;
        const action = actionText(data);
        if (action) actionRef.current?.(action);
      },
    });
    ui.render(dsl);
    return () => {
      ui.disconnect();
    };
  }, [dsl, theme]);

  return <div ref={containerRef} style={{ display: 'contents' }} />;
}

export default TokUIView;
