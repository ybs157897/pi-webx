/**
 * The a2ui-style spec: a declarative description of a UI that an agent emits as
 * data and the web client renders with real components. Nothing here is ever
 * executed — an unknown component kind is dropped, not evaluated.
 *
 * Reach it two ways:
 *   1. the `render_ui` tool registered by the bundled pi extension (primary)
 *   2. a fenced ```a2ui block in assistant text (fallback for models that
 *      prefer to answer in prose)
 */

export type UiAlign = 'start' | 'center' | 'end' | 'stretch';

export type UiFieldKind = 'text' | 'email' | 'password' | 'number';

export interface UiField {
  t: 'input' | 'textarea' | 'select' | 'checkbox' | 'switch';
  k: string;
  label: string;
  ph?: string;
  required?: boolean;
  kind?: UiFieldKind;
  rows?: number;
  options?: string[];
  checked?: boolean;
}

export interface UiButtonSpec {
  v: string;
  kind?: 'primary' | 'default' | 'dashed' | 'danger';
  action?: string;
}

export type UiChartKind = 'line' | 'bar' | 'area' | 'pie';

export type UiNode =
  /* layout */
  | { t: 'row'; children?: UiNode[]; gap?: number; align?: UiAlign; wrap?: boolean }
  | { t: 'col'; children?: UiNode[]; gap?: number }
  | { t: 'card'; title?: string; variant?: 'outlined' | 'highlight' | 'flat'; children?: UiNode[] }
  | { t: 'divider' }
  /* typography */
  | { t: 'title'; v: string; level?: 1 | 2 | 3 | 4 }
  | { t: 'text'; v: string; kind?: 'p' | 'secondary' | 'code' | 'strong' }
  | { t: 'md'; v: string }
  /* data display */
  | {
      t: 'stat';
      label: string;
      value: number | string;
      unit?: string;
      trend?: 'up' | 'down';
      hint?: string;
    }
  | {
      t: 'table';
      columns: { k: string; title: string; w?: number }[];
      rows: Record<string, unknown>[];
    }
  | { t: 'desc'; title?: string; cols?: 1 | 2 | 3; items: { k: string; v: unknown }[] }
  | { t: 'tags'; items: string[] }
  | { t: 'callout'; kind?: 'info' | 'success' | 'warning' | 'error'; title?: string; v: string }
  | { t: 'code'; v: string; lang?: string }
  | { t: 'list'; items: (string | { title: string; desc?: string })[] }
  /* interaction */
  | { t: 'form'; title?: string; fields: UiField[]; submit?: string; action?: string }
  | { t: 'button'; v: string; kind?: UiButtonSpec['kind']; action?: string }
  | { t: 'btngroup'; buttons: UiButtonSpec[] }
  /* charts */
  | {
      t: 'chart';
      kind: UiChartKind;
      labels: string[];
      series: { name: string; data: number[] }[];
      height?: number;
    };

export const UI_NODE_KINDS = [
  'row',
  'col',
  'card',
  'divider',
  'title',
  'text',
  'md',
  'stat',
  'table',
  'desc',
  'tags',
  'callout',
  'code',
  'list',
  'form',
  'button',
  'btngroup',
  'chart',
] as const;

export interface UiSpec {
  title?: string;
  root: UiNode[];
}

/* ------------------------------------------------------------------ limits */

const MAX_NODES = 400;
const MAX_DEPTH = 12;
const MAX_STRING = 8_000;
const MAX_COLLECTION = 200;

/** Models often emit the spec as a JSON-encoded string; unwrap up to twice. */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Coerces untrusted agent output into a bounded `UiSpec`. Returns null when
 * nothing renderable remains. Never throws.
 */
export function normalizeUiSpec(input: unknown): UiSpec | null {
  let budget = MAX_NODES;

  const str = (value: unknown, max = MAX_STRING): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
  };

  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const bool = (value: unknown): boolean | undefined =>
    typeof value === 'boolean' ? value : undefined;

  const strArray = (value: unknown, max = MAX_COLLECTION): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value.map((entry) => str(entry, 400)).filter((entry): entry is string => !!entry);
    return out.length > 0 ? out.slice(0, max) : undefined;
  };

  const fields = (value: unknown): UiField[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out: UiField[] = [];
    for (const raw of value.slice(0, 40)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      const kind = record['t'];
      const key = str(record['k'], 120);
      const label = str(record['label'], 200);
      if (typeof kind !== 'string' || !key || !label) continue;
      const known = ['input', 'textarea', 'select', 'checkbox', 'switch'] as const;
      if (!(known as readonly string[]).includes(kind)) continue;
      const field: UiField = {
        t: kind as UiField['t'],
        k: key,
        label,
        ...(bool(record['required']) === undefined
          ? {}
          : { required: record['required'] as boolean }),
      };
      const placeholder = str(record['ph'], 200);
      if (placeholder) field.ph = placeholder;
      if (kind === 'input') {
        const inputKind = str(record['kind'], 20) as UiFieldKind | undefined;
        if (inputKind && ['text', 'email', 'password', 'number'].includes(inputKind)) {
          field.kind = inputKind;
        }
      }
      if (kind === 'textarea') {
        const rows = num(record['rows']);
        if (rows) field.rows = Math.min(20, Math.max(2, Math.round(rows)));
      }
      if (kind === 'select') {
        const options = strArray(record['options'], 100);
        if (options) field.options = options;
      }
      if (kind === 'checkbox' || kind === 'switch') {
        const checked = bool(record['checked']);
        if (checked !== undefined) field.checked = checked;
      }
      out.push(field);
    }
    return out.length > 0 ? out : undefined;
  };

  const buttons = (value: unknown): UiButtonSpec[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out: UiButtonSpec[] = [];
    for (const raw of value.slice(0, 12)) {
      if (typeof raw === 'string') {
        const label = str(raw, 200);
        if (label) out.push({ v: label });
        continue;
      }
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      const label = str(record['v'] ?? record['label'], 200);
      if (!label) continue;
      const kind = str(record['kind'], 20);
      out.push({
        v: label,
        ...(kind && ['primary', 'default', 'dashed', 'danger'].includes(kind)
          ? { kind: kind as UiButtonSpec['kind'] }
          : {}),
        ...(str(record['action'], 2_000) ? { action: str(record['action'], 2_000) } : {}),
      });
    }
    return out.length > 0 ? out : undefined;
  };

  const node = (raw: unknown, depth: number): UiNode | null => {
    if (budget <= 0 || depth > MAX_DEPTH) return null;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const kind = record['t'];
    if (typeof kind !== 'string') return null;
    if (!(UI_NODE_KINDS as readonly string[]).includes(kind)) return null;
    budget -= 1;

    const kids = (): UiNode[] | undefined => {
      if (!Array.isArray(record['children'])) return undefined;
      const out: UiNode[] = [];
      for (const child of record['children'].slice(0, MAX_COLLECTION)) {
        const rendered = node(child, depth + 1);
        if (rendered) out.push(rendered);
        if (budget <= 0) break;
      }
      return out.length > 0 ? out : undefined;
    };

    switch (kind) {
      case 'row': {
        const children = kids();
        const gap = num(record['gap']);
        const align = str(record['align'], 20);
        return {
          t: 'row',
          ...(children ? { children } : {}),
          ...(gap ? { gap: Math.min(48, Math.round(gap)) } : {}),
          ...(align && ['start', 'center', 'end', 'stretch'].includes(align)
            ? { align: align as UiAlign }
            : {}),
          ...(record['wrap'] === true ? { wrap: true } : {}),
        };
      }
      case 'col': {
        const children = kids();
        const gap = num(record['gap']);
        return {
          t: 'col',
          ...(children ? { children } : {}),
          ...(gap ? { gap: Math.min(48, Math.round(gap)) } : {}),
        };
      }
      case 'card': {
        const children = kids();
        const variant = str(record['variant'], 20);
        return {
          t: 'card',
          ...(str(record['title'], 300) ? { title: str(record['title'], 300) } : {}),
          ...(variant && ['outlined', 'highlight', 'flat'].includes(variant)
            ? { variant: variant as 'outlined' | 'highlight' | 'flat' }
            : {}),
          ...(children ? { children } : {}),
        };
      }
      case 'divider':
        return { t: 'divider' };
      case 'title': {
        const v = str(record['v'], 400);
        if (!v) return null;
        const level = num(record['level']);
        return {
          t: 'title',
          v,
          ...(level
            ? { level: Math.min(4, Math.max(1, Math.round(level))) as 1 | 2 | 3 | 4 }
            : {}),
        };
      }
      case 'text': {
        const v = str(record['v']);
        if (!v) return null;
        const textKind = str(record['kind'], 20);
        return {
          t: 'text',
          v,
          ...(textKind && ['p', 'secondary', 'code', 'strong'].includes(textKind)
            ? { kind: textKind as 'p' | 'secondary' | 'code' | 'strong' }
            : {}),
        };
      }
      case 'md': {
        const v = str(record['v'], MAX_STRING);
        return v ? { t: 'md', v } : null;
      }
      case 'stat': {
        const label = str(record['label'], 200);
        if (!label) return null;
        const rawValue = record['value'];
        const value =
          typeof rawValue === 'number' && Number.isFinite(rawValue)
            ? rawValue
            : str(rawValue, 200);
        if (value === undefined) return null;
        const trend = str(record['trend'], 10);
        return {
          t: 'stat',
          label,
          value,
          ...(str(record['unit'], 40) ? { unit: str(record['unit'], 40) } : {}),
          ...(trend === 'up' || trend === 'down' ? { trend } : {}),
          ...(str(record['hint'], 300) ? { hint: str(record['hint'], 300) } : {}),
        };
      }
      case 'table': {
        if (!Array.isArray(record['columns']) || !Array.isArray(record['rows'])) return null;
        const columns = record['columns'].slice(0, 24).flatMap((rawColumn) => {
          if (typeof rawColumn !== 'object' || rawColumn === null) return [];
          const column = rawColumn as Record<string, unknown>;
          const key = str(column['k'], 120);
          const title = str(column['title'], 200);
          if (!key || !title) return [];
          const width = num(column['w']);
          return [{ k: key, title, ...(width ? { w: Math.min(800, Math.round(width)) } : {}) }];
        });
        if (columns.length === 0) return null;
        const rows = record['rows'].slice(0, MAX_COLLECTION).flatMap((rawRow) => {
          if (typeof rawRow !== 'object' || rawRow === null || Array.isArray(rawRow)) return [];
          const clean: Record<string, unknown> = {};
          for (const column of columns) {
            const cell = (rawRow as Record<string, unknown>)[column.k];
            if (cell === undefined || cell === null) continue;
            clean[column.k] =
              typeof cell === 'string'
                ? str(cell, 2_000) ?? ''
                : typeof cell === 'number' && Number.isFinite(cell)
                  ? cell
                  : String(cell);
          }
          return [clean];
        });
        return { t: 'table', columns, rows };
      }
      case 'desc': {
        if (!Array.isArray(record['items'])) return null;
        const items = record['items'].slice(0, 60).flatMap((rawItem) => {
          if (typeof rawItem !== 'object' || rawItem === null) return [];
          const item = rawItem as Record<string, unknown>;
          const key = str(item['k'], 200);
          if (!key) return [];
          const value = item['v'];
          return [
            {
              k: key,
              v:
                typeof value === 'string'
                  ? str(value, 2_000) ?? ''
                  : typeof value === 'number' && Number.isFinite(value)
                    ? value
                    : String(value),
            },
          ];
        });
        if (items.length === 0) return null;
        const cols = num(record['cols']);
        return {
          t: 'desc',
          ...(str(record['title'], 300) ? { title: str(record['title'], 300) } : {}),
          ...(cols ? { cols: Math.min(3, Math.max(1, Math.round(cols))) as 1 | 2 | 3 } : {}),
          items,
        };
      }
      case 'tags': {
        const items = strArray(record['items'], 100);
        return items ? { t: 'tags', items } : null;
      }
      case 'callout': {
        const v = str(record['v'], MAX_STRING);
        if (!v) return null;
        const tone = str(record['kind'], 20);
        return {
          t: 'callout',
          v,
          ...(str(record['title'], 300) ? { title: str(record['title'], 300) } : {}),
          ...(tone && ['info', 'success', 'warning', 'error'].includes(tone)
            ? { kind: tone as 'info' | 'success' | 'warning' | 'error' }
            : {}),
        };
      }
      case 'code': {
        const v = str(record['v'], MAX_STRING);
        return v
          ? { t: 'code', v, ...(str(record['lang'], 40) ? { lang: str(record['lang'], 40) } : {}) }
          : null;
      }
      case 'list': {
        if (!Array.isArray(record['items'])) return null;
        const items: (string | { title: string; desc?: string })[] = [];
        for (const rawItem of record['items'].slice(0, MAX_COLLECTION)) {
          if (typeof rawItem === 'string') {
            const text = str(rawItem, 2_000);
            if (text) items.push(text);
            continue;
          }
          if (typeof rawItem !== 'object' || rawItem === null) continue;
          const item = rawItem as Record<string, unknown>;
          const title = str(item['title'], 400);
          if (!title) continue;
          const desc = str(item['desc'], 2_000);
          items.push(desc ? { title, desc } : { title });
        }
        return items.length > 0 ? { t: 'list', items } : null;
      }
      case 'form': {
        const spec = fields(record['fields']);
        if (!spec) return null;
        return {
          t: 'form',
          ...(str(record['title'], 300) ? { title: str(record['title'], 300) } : {}),
          ...(str(record['submit'], 100) ? { submit: str(record['submit'], 100) } : {}),
          ...(str(record['action'], 2_000) ? { action: str(record['action'], 2_000) } : {}),
          fields: spec,
        };
      }
      case 'button': {
        const label = str(record['v'] ?? record['label'], 200);
        if (!label) return null;
        const buttonKind = str(record['kind'], 20);
        return {
          t: 'button',
          v: label,
          ...(buttonKind && ['primary', 'default', 'dashed', 'danger'].includes(buttonKind)
            ? { kind: buttonKind as UiButtonSpec['kind'] }
            : {}),
          ...(str(record['action'], 2_000) ? { action: str(record['action'], 2_000) } : {}),
        };
      }
      case 'btngroup': {
        const group = buttons(record['buttons']);
        return group ? { t: 'btngroup', buttons: group } : null;
      }
      case 'chart': {
        const chartKind = str(record['kind'], 20);
        if (!chartKind || !['line', 'bar', 'area', 'pie'].includes(chartKind)) return null;
        if (!Array.isArray(record['series'])) return null;
        const series = record['series'].slice(0, 8).flatMap((rawSeries) => {
          if (typeof rawSeries !== 'object' || rawSeries === null) return [];
          const entry = rawSeries as Record<string, unknown>;
          const name = str(entry['name'], 200);
          if (!name || !Array.isArray(entry['data'])) return [];
          const data = entry['data']
            .slice(0, MAX_COLLECTION)
            .map((point) => (typeof point === 'number' && Number.isFinite(point) ? point : Number.NaN))
            .filter((point) => !Number.isNaN(point));
          return data.length > 0 ? [{ name, data }] : [];
        });
        if (series.length === 0) return null;
        const height = num(record['height']);
        return {
          t: 'chart',
          kind: chartKind as UiChartKind,
          labels: strArray(record['labels'], MAX_COLLECTION) ?? [],
          series,
          ...(height ? { height: Math.min(520, Math.max(120, Math.round(height))) } : {}),
        };
      }
      default:
        return null;
    }
  };

  // Tolerate a double-encoded spec before looking at its shape.
  let candidate: unknown = input;
  for (let round = 0; round < 2 && typeof candidate === 'string'; round += 1) {
    const parsed = tryParseJson(candidate);
    if (parsed === undefined) break;
    candidate = parsed;
  }

  const collect = (source: unknown): UiNode[] => {
    if (Array.isArray(source)) {
      return source.flatMap((entry) => {
        const rendered = node(entry, 1);
        return rendered ? [rendered] : [];
      });
    }
    const rendered = node(source, 1);
    return rendered ? [rendered] : [];
  };

  let roots: UiNode[] = [];
  let title: string | undefined;

  if (Array.isArray(candidate)) {
    roots = collect(candidate);
  } else if (typeof candidate === 'object' && candidate !== null) {
    const record = candidate as Record<string, unknown>;
    title = str(record['title'], 300);
    let source: unknown = 'root' in record ? record['root'] : record;
    for (let round = 0; round < 2 && typeof source === 'string'; round += 1) {
      const parsed = tryParseJson(source);
      if (parsed === undefined) break;
      source = parsed;
    }
    roots = collect(source);
  }

  if (roots.length === 0) return null;
  return { ...(title ? { title } : {}), root: roots };
}

/**
 * Extracts ```a2ui fenced blocks from assistant text. Returns the raw block
 * bodies in order; parsing each into a spec is the caller's job.
 */
export function extractA2uiBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(/```a2ui\s*\n([\s\S]*?)```/g)) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
    if (blocks.length >= 8) break;
  }
  return blocks;
}

/**
 * Removes ```a2ui fenced blocks from markdown, so the same agent message can be
 * rendered as text plus real components instead of showing the raw JSON twice.
 */
export function stripA2uiBlocks(text: string): string {
  return text.replace(/```a2ui\s*\n[\s\S]*?```/g, '').trim();
}

/** Parses one fenced a2ui block body into a spec; null on bad JSON or shape. */
export function parseA2uiBlock(body: string): UiSpec | null {
  try {
    return normalizeUiSpec(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

/**
 * `render_ui` tool-call arguments may carry `{title?, spec}` or be the spec
 * itself — models do both. Unwrap and normalize.
 */
export function specFromToolArgs(args: unknown): UiSpec | null {
  if (typeof args !== 'object' || args === null) return null;
  const record = args as Record<string, unknown>;
  return normalizeUiSpec('spec' in record ? record['spec'] : args);
}

/**
 * Reads the spec out of a tool run: prefer the extension's normalized echo in
 * `result.details.a2ui`, fall back to the raw call arguments.
 */
export function specFromToolRun(run: { args: Record<string, unknown>; details?: unknown }): UiSpec | null {
  const details = run.details;
  if (typeof details === 'object' && details !== null && 'a2ui' in details) {
    const spec = normalizeUiSpec((details as Record<string, unknown>)['a2ui']);
    if (spec) return spec;
  }
  return specFromToolArgs(run.args);
}
