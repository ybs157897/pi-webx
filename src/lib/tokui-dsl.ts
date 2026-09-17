/**
 * Converts our a2ui JSON spec into a TokUI bracket-DSL string, for the
 * TokUI rendering path. Best-effort: unknown nodes degrade to a note rather
 * than throwing, and text/attr values are sanitized so the bracket grammar
 * can never be broken by agent output.
 */

import type { UiField, UiNode, UiSpec } from '../shared/uikit';

/** Values carrying spaces must be quoted; `"` and brackets are neutralized. */
function attr(key: string, value: string | number | boolean | undefined): string {
  if (value === undefined) return '';
  const raw = String(value).replace(/["[\]]/g, '”').trim();
  if (raw.length === 0) return '';
  return raw.includes(' ') || raw.includes(',') || raw.includes('|')
    ? ` ${key}:"${raw}"`
    : ` ${key}:${raw}`;
}

/** Content text must not carry live brackets; full-width brackets read the same. */
function text(value: string): string {
  return value.replace(/\[/g, '［').replace(/\]/g, '］');
}

const TREND: Record<string, string> = { up: 'up', down: 'down' };
const CALLOUT: Record<string, string> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
};
const CHART: Record<string, string> = { line: 'line', bar: 'bar', area: 'line', pie: 'pie' };

function field(f: UiField): string {
  const name = attr('n', f.k);
  const label = attr('l', f.label);
  const req = f.required ? ' req' : '';
  switch (f.t) {
    case 'input':
      return `[input${label}${name}${attr('ph', f.ph)}${req}${attr('t', f.kind === 'password' ? 'password' : undefined)}]`;
    case 'textarea':
      return `[textarea${label}${name}${attr('ph', f.ph)}${attr('rows', f.rows)}${req}]`;
    case 'select':
      return `[select${label}${name}${req}]${(f.options ?? [])
        .map((option) => `[opt v:${text(option)}]`)
        .join('')}[/select]`;
    case 'checkbox':
      return `[checkbox${label}${name}${f.checked ? ' chk' : ''}]`;
    case 'switch':
      return `[toggle${label}${name}${f.checked ? ' chk' : ''}]`;
    default:
      return '';
  }
}

function buttonSpec(b: { v: string; kind?: 'primary' | 'default' | 'dashed' | 'danger'; action?: string }): string {
  const variant =
    b.kind === 'primary' ? 'primary' : b.kind === 'danger' ? 'danger' : b.kind === 'dashed' ? 'dashed' : undefined;
  return `[btn tt:${text(b.v)}${variant ? attr('v', variant) : ''}${b.action ? attr('clk', b.action) : attr('clk', b.v)}]`;
}

function node(n: UiNode): string {
  switch (n.t) {
    case 'row': {
      const kids = (n.children ?? []).map(node).filter(Boolean);
      const span = kids.length > 0 ? Math.max(1, Math.floor(12 / kids.length)) : 12;
      return `[row${attr('gutter', n.gap)}]${kids.map((child) => `[col span:${span}]${child}[/col]`).join('')}[/row]`;
    }
    case 'col':
      return `[col span:12]${(n.children ?? []).map(node).join('')}[/col]`;
    case 'card':
      return `[card${attr('tt', n.title)}]${(n.children ?? []).map(node).join('')}[/card]`;
    case 'divider':
      return '[dv]';
    case 'title':
      return `[h${Math.min(4, Math.max(1, n.level ?? 2))} ${text(n.v)}]`;
    case 'text':
      return `[p${n.kind === 'secondary' ? attr('v', 'secondary') : ''}]${text(n.v)}`;
    case 'md':
      return `[md]${text(n.v)}[/md]`;
    case 'stat':
      return `[stat${attr('tt', n.label)}${attr('v', n.value)}${attr('suf', n.unit)}${attr('trend', n.trend ? TREND[n.trend] : undefined)}${attr('l', n.hint)}]`;
    case 'table': {
      const cols = n.columns.map((column) => column.title).join(',');
      const rows = n.rows
        .map((row) => `[tr "${n.columns.map((column) => text(String(row[column.k] ?? '—'))).join(',')}"]`)
        .join('');
      return `[table][thead cols:"${cols}"][tbody]${rows}[/tbody][/table]`;
    }
    case 'desc':
      return `[desc${attr('cols', n.cols ?? 1)}]${n.items
        .map((item) => `[desc-item${attr('l', item.k)}${attr('tx', String(item.v))}]`)
        .join('')}[/desc]`;
    case 'tags':
      return n.items.map((item) => `[tag ${text(item)}]`).join('');
    case 'callout':
      return `[callout${attr('t', n.kind ? CALLOUT[n.kind] : 'info')}${attr('tt', n.title)}${attr('tx', n.v)}]`;
    case 'code':
      return `[code]${text(n.v)}[/code]`;
    case 'list':
      return `[list]${n.items
        .map((item) => `[i ${typeof item === 'string' ? text(item) : text(item.title)}]`)
        .join('')}[/list]`;
    case 'form':
      return `[form${attr('tt', n.title)}]${n.fields.map(field).join('')}[btn tt:${text(n.submit ?? '提交')} v:primary sub:send][/form]`;
    case 'button':
      return buttonSpec(n);
    case 'btngroup':
      return `[btngroup]${n.buttons.map(buttonSpec).join('')}[/btngroup]`;
    case 'chart': {
      const labels = n.labels.join(',');
      const data = n.series.map((series) => series.data.join(',')).join('|');
      const kind = CHART[n.kind] ?? 'line';
      const area = n.kind === 'area' ? ' area' : '';
      return `[chart${attr('t', kind)}${attr('tt', n.series[0]?.name)}${attr('l', labels)}${attr('d', data)}${area}${attr('h', n.height)}]`;
    }
    default:
      return `[callout t:info tt:未支持的组件${attr('tx', (n as { t?: string }).t ?? '')}]`;
  }
}

/** Full spec → a TokUI DSL string. */
export function specToTokDsl(spec: UiSpec): string {
  return spec.root.map(node).join('');
}

export { node as jsonToTokDsl };
