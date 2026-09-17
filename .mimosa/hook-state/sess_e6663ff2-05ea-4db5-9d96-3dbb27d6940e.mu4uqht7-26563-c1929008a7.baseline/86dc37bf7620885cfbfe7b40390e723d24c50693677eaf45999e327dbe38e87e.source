import { theme } from 'antd';
import type { ReactNode } from 'react';

/**
 * One named data series. `data` is aligned with `labels` by index; entries that
 * are not finite numbers (NaN / Infinity / non-number) are treated as gaps and
 * skipped instead of being plotted.
 */
export interface UiChartSeries {
  name: string;
  data: number[];
}

/**
 * A chart spec. Specs are produced by the agent, so every field is validated at
 * runtime before it reaches the SVG.
 */
export interface UiChartProps {
  kind: 'line' | 'bar' | 'area' | 'pie';
  labels: string[];
  series: UiChartSeries[];
  /** pixel height of the plot area; default 220 */
  height?: number;
}

/* ------------------------------------------------------------------ */
/* geometry constants — everything is laid out in a 640-wide viewBox  */
/* ------------------------------------------------------------------ */

const VIEW_WIDTH = 640;
const DEFAULT_HEIGHT = 220;
const MIN_HEIGHT = 80;
const PAD_LEFT = 54;
const PAD_RIGHT = 20;
const PAD_TOP = 18;
/** Room reserved below the plot for the x labels. */
const AXIS_GUTTER = 24;
const MAX_X_LABELS = 8;
const TICK_INTERVALS = 3;
const MAX_TICK_INTERVALS = 3;
const DOT_LIMIT = 48;
const MAX_LABEL_CHARS = 8;

const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const PERCENT_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

/** Categorical series colors, resolved from the antd palette with a static fallback. */
const PALETTE_KEYS = [
  'colorPrimary',
  'green6',
  'orange6',
  'purple6',
  'magenta6',
  'cyan6',
  'gold6',
] as const;
const PALETTE_FALLBACK = [
  '#1677ff',
  '#52c41a',
  '#fa8c16',
  '#722ed1',
  '#eb2f96',
  '#13c2c2',
  '#faad14',
];

const KIND_LABEL: Record<string, string> = {
  line: '折线图',
  bar: '柱状图',
  area: '面积图',
  pie: '饼图',
};

const EMPTY_TEXT = '暂无数据';

interface Point {
  x: number;
  y: number;
}

interface Scale {
  lo: number;
  hi: number;
  ticks: number[];
}

interface NormalizedSeries {
  name: string;
  values: (number | null)[];
}

interface PieArc {
  index: number;
  value: number;
  start: number;
  end: number;
}

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Serializes a number for an SVG attribute; never emits NaN or Infinity. */
function num(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0';
}

/** Drops the trailing `.0` of one-decimal text so `1.0万` reads as `1万`. */
function trimDecimal(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(1))) : '—';
}

/** Compact, locale-aware number text for axes, bar labels and legends. */
function formatNumber(input: number): string {
  const value = input === 0 ? 0 : input;
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${trimDecimal(value / 1e8)}亿`;
  if (abs >= 1e4) return `${trimDecimal(value / 1e4)}万`;
  return NUMBER_FORMAT.format(value);
}

function formatPercent(share: number): string {
  return Number.isFinite(share) ? `${PERCENT_FORMAT.format(share * 100)}%` : '—';
}

function truncateLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 1 / 2 / 5 / 10 progression, so tick text stays readable. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

/** Rounds a domain outwards to nice ticks and returns 2–4 gridline values. */
function buildScale(loIn: number, hiIn: number): Scale {
  if (loIn === 0 && hiIn === 0) return { lo: 0, hi: 1, ticks: [0, 0.5, 1] };

  let lo = loIn;
  let hi = hiIn;
  if (!(hi > lo)) {
    // Flat data: invent a band around it so the line is still visible.
    const pad = Math.abs(lo) * 0.5 || 1;
    lo -= pad;
    hi += pad;
  }

  const step = niceStep((hi - lo) / TICK_INTERVALS);
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hi / step) * step;
  const intervals = Math.round((niceHi - niceLo) / step);

  if (intervals >= 1 && intervals <= MAX_TICK_INTERVALS) {
    const ticks: number[] = [];
    for (let i = 0; i <= intervals; i += 1) ticks.push(niceLo + i * step);
    return { lo: niceLo, hi: niceHi, ticks };
  }

  // Too many candidates for a tidy axis: fall back to min / mid / max.
  return { lo: niceLo, hi: niceHi, ticks: [niceLo, (niceLo + niceHi) / 2, niceHi] };
}

/** Cubic path through every point, using horizontal tangents at the midpoints. */
function smoothPath(points: Point[]): string {
  const first = points[0];
  if (!first) return '';
  let d = `M ${num(first.x)} ${num(first.y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const current = points[i];
    if (!prev || !current) continue;
    const midX = (prev.x + current.x) / 2;
    d += ` C ${num(midX)} ${num(prev.y)}, ${num(midX)} ${num(current.y)}, ${num(current.x)} ${num(current.y)}`;
  }
  return d;
}

/** Bar outline with rounded top corners only. */
function barPath(x: number, yFrom: number, yTo: number, width: number): string {
  const top = Math.min(yFrom, yTo);
  const bottom = Math.max(yFrom, yTo);
  const right = x + width;
  const radius = Math.max(0, Math.min(3, width / 2, bottom - top));
  const flat = `L ${num(right)} ${num(bottom)} L ${num(x)} ${num(bottom)} Z`;

  if (radius <= 0.5) {
    return `M ${num(x)} ${num(top)} L ${num(right)} ${num(top)} ${flat}`;
  }
  return (
    `M ${num(x)} ${num(top + radius)}` +
    ` Q ${num(x)} ${num(top)} ${num(x + radius)} ${num(top)}` +
    ` L ${num(right - radius)} ${num(top)}` +
    ` Q ${num(right)} ${num(top)} ${num(right)} ${num(top + radius)}` +
    ` L ${num(right)} ${num(bottom)}` +
    ` L ${num(x)} ${num(bottom)} Z`
  );
}

function polar(cx: number, cy: number, radius: number, angle: number): Point {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

/** Closed annular sector (donut wedge) drawn clockwise from `a0` to `a1`. */
function annularSector(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  a0: number,
  a1: number,
): string {
  const largeArc = a1 - a0 > Math.PI ? 1 : 0;
  const o0 = polar(cx, cy, outer, a0);
  const o1 = polar(cx, cy, outer, a1);
  const i1 = polar(cx, cy, inner, a1);
  const i0 = polar(cx, cy, inner, a0);
  return (
    `M ${num(o0.x)} ${num(o0.y)}` +
    ` A ${num(outer)} ${num(outer)} 0 ${largeArc} 1 ${num(o1.x)} ${num(o1.y)}` +
    ` L ${num(i1.x)} ${num(i1.y)}` +
    ` A ${num(inner)} ${num(inner)} 0 ${largeArc} 0 ${num(i0.x)} ${num(i0.y)} Z`
  );
}

/** A full sweep cannot be one arc, so it is emitted as two half rings. */
function arcPath(cx: number, cy: number, outer: number, inner: number, a0: number, a1: number): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    const mid = a0 + Math.PI;
    return `${annularSector(cx, cy, outer, inner, a0, mid)} ${annularSector(cx, cy, outer, inner, mid, a1)}`;
  }
  return annularSector(cx, cy, outer, inner, a0, a1);
}

function normalizeSeries(series: unknown): NormalizedSeries[] {
  if (!Array.isArray(series)) return [];
  return series.map((entry, index) => {
    const record = (entry ?? {}) as { name?: unknown; data?: unknown };
    const rawName = typeof record.name === 'string' ? record.name.trim() : '';
    const rawData = Array.isArray(record.data) ? record.data : [];
    return {
      name: rawName || `系列 ${index + 1}`,
      values: rawData.map((value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) ? value : null,
      ),
    };
  });
}

function normalizeLabels(labels: unknown): string[] {
  const list = Array.isArray(labels) ? labels : [];
  return list.map((label, index) =>
    typeof label === 'string' && label.trim() !== '' ? label : String(index + 1),
  );
}

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

/**
 * Renders an agent-generated chart spec as static SVG: no chart library, no
 * interactivity, safe on degenerate or hostile input.
 */
export function UiChart({ kind, labels, series, height }: UiChartProps) {
  const { token } = theme.useToken();

  const boxHeight =
    typeof height === 'number' && Number.isFinite(height) && height >= MIN_HEIGHT
      ? Math.round(height)
      : DEFAULT_HEIGHT;

  const safeSeries = normalizeSeries(series);
  const safeLabels = normalizeLabels(labels);

  const colors = PALETTE_KEYS.map(
    (key, index) => token[key] || PALETTE_FALLBACK[index] || '#1677ff',
  );
  const colorAt = (index: number): string =>
    colors[((index % colors.length) + colors.length) % colors.length] ?? token.colorPrimary;

  const emptyState = (
    <div style={{ width: '100%' }}>
      <svg
        aria-label={`${KIND_LABEL[kind] ?? '图表'}：${EMPTY_TEXT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        style={{ display: 'block', width: '100%', height: boxHeight }}
        viewBox={`0 0 ${VIEW_WIDTH} ${boxHeight}`}
      >
        <text
          dominantBaseline="central"
          fill={token.colorTextTertiary}
          fontSize={12}
          textAnchor="middle"
          x={num(VIEW_WIDTH / 2)}
          y={num(boxHeight / 2)}
        >
          {EMPTY_TEXT}
        </text>
      </svg>
    </div>
  );

  if (safeSeries.length === 0) return emptyState;

  const nMax = safeSeries.reduce((max, item) => Math.max(max, item.values.length), 0);
  const finiteValues: number[] = [];
  for (const item of safeSeries) {
    for (const value of item.values) {
      if (value !== null) finiteValues.push(value);
    }
  }

  const legendRow = (items: { color: string; label: string; value: string | null }[]) => (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px 14px',
        marginTop: 8,
      }}
    >
      {items.map((item, index) => (
        <span
          key={`${item.label}-${index}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: '100%',
            minWidth: 0,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              flexShrink: 0,
              background: item.color,
              borderRadius: 2,
            }}
          />
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              fontSize: 12,
              color: token.colorTextSecondary,
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.label}
          </span>
          {item.value === null ? null : (
            <span
              style={{
                flexShrink: 0,
                fontSize: 11,
                color: token.colorTextTertiary,
                fontFamily: token.fontFamilyCode,
              }}
            >
              {item.value}
            </span>
          )}
        </span>
      ))}
    </div>
  );

  /* ---------------- pie ---------------- */

  if (kind === 'pie') {
    const first = safeSeries[0];
    const source = first ? first.values : [];
    let total = 0;
    for (const value of source) {
      if (value !== null && value > 0) total += value;
    }
    if (total <= 0) return emptyState;

    const arcs: PieArc[] = [];
    let cursor = -Math.PI / 2;
    source.forEach((value, index) => {
      if (value === null || value <= 0) return;
      const sweep = (value / total) * Math.PI * 2;
      arcs.push({ index, value, start: cursor, end: cursor + sweep });
      cursor += sweep;
    });

    const gap = arcs.length > 1 ? 0.02 : 0;
    const cx = VIEW_WIDTH / 2;
    const cy = boxHeight / 2;
    const outer = Math.max(24, Math.min(150, cy - 10));
    const inner = outer * 0.58;
    const label = first ? first.name : '';

    return (
      <div style={{ width: '100%' }}>
        <svg
          aria-label={`${KIND_LABEL.pie ?? '图表'}：${label}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          style={{ display: 'block', width: '100%', height: boxHeight }}
          viewBox={`0 0 ${VIEW_WIDTH} ${boxHeight}`}
        >
          {arcs.map((arc) => (
            <path
              key={`slice-${arc.index}`}
              d={arcPath(cx, cy, outer, inner, arc.start + gap / 2, arc.end - gap / 2)}
              fill={colorAt(arc.index)}
            />
          ))}
          {inner >= 34 ? (
            <>
              <text
                dominantBaseline="central"
                fill={token.colorText}
                fontSize={17}
                fontWeight={600}
                style={{ fontFamily: token.fontFamilyCode }}
                textAnchor="middle"
                x={num(cx)}
                y={num(cy - 7)}
              >
                {formatNumber(total)}
              </text>
              <text
                dominantBaseline="central"
                fill={token.colorTextTertiary}
                fontSize={10}
                textAnchor="middle"
                x={num(cx)}
                y={num(cy + 12)}
              >
                合计
              </text>
            </>
          ) : null}
        </svg>
        {legendRow(
          arcs.map((arc) => ({
            color: colorAt(arc.index),
            label: safeLabels[arc.index] ?? String(arc.index + 1),
            value: `${formatNumber(arc.value)}（${formatPercent(arc.value / total)}）`,
          })),
        )}
      </div>
    );
  }

  /* ---------------- line / area / bar ---------------- */

  if (nMax === 0 || finiteValues.length === 0) return emptyState;

  let min = Infinity;
  let max = -Infinity;
  for (const value of finiteValues) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min;
  // Bars and areas read from zero; lines only anchor to zero when the data is
  // already sitting close to it, so small movements stay legible.
  const anchorZero = kind === 'bar' || kind === 'area' || (min >= 0 && min <= span);
  const scale = buildScale(
    anchorZero ? Math.min(0, min) : min,
    anchorZero ? Math.max(0, max) : max,
  );

  const plotWidth = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = Math.max(24, boxHeight - PAD_TOP - AXIS_GUTTER);
  const plotBottom = PAD_TOP + plotHeight;
  const plotRight = VIEW_WIDTH - PAD_RIGHT;
  const ratio = scale.hi - scale.lo;
  const yAt = (value: number): number =>
    PAD_TOP + ((scale.hi - Math.min(Math.max(value, scale.lo), scale.hi)) / ratio) * plotHeight;
  const xAt = (index: number): number =>
    nMax <= 1 ? PAD_LEFT + plotWidth / 2 : PAD_LEFT + (index / (nMax - 1)) * plotWidth;
  const baseY = yAt(Math.min(Math.max(0, scale.lo), scale.hi));

  const stride = Math.max(1, Math.ceil(nMax / MAX_X_LABELS));
  const bandWidth = plotWidth / nMax;
  const labelX = (index: number): number => {
    const raw = kind === 'bar' ? PAD_LEFT + index * bandWidth + bandWidth / 2 : xAt(index);
    return Math.min(Math.max(raw, 36), VIEW_WIDTH - 36);
  };

  const axisTicks = (
    <>
      {scale.ticks.map((tick) => (
        <g key={`tick-${tick}`}>
          <line
            stroke={token.colorSplit}
            strokeWidth={1}
            x1={num(PAD_LEFT)}
            x2={num(plotRight)}
            y1={num(yAt(tick))}
            y2={num(yAt(tick))}
          />
          <text
            dominantBaseline="central"
            fill={token.colorTextSecondary}
            fontSize={11}
            style={{ fontFamily: token.fontFamilyCode }}
            textAnchor="end"
            x={num(PAD_LEFT - 10)}
            y={num(yAt(tick))}
          >
            {formatNumber(tick)}
          </text>
        </g>
      ))}
      <line
        stroke={token.colorBorderSecondary}
        strokeWidth={1}
        x1={num(PAD_LEFT)}
        x2={num(plotRight)}
        y1={num(plotBottom)}
        y2={num(plotBottom)}
      />
      {Array.from({ length: Math.ceil(nMax / stride) }, (_, step) => step * stride)
        .filter((index) => index < nMax)
        .map((index) => (
          <text
            key={`xlabel-${index}`}
            fill={token.colorTextSecondary}
            fontSize={11}
            textAnchor="middle"
            x={num(labelX(index))}
            y={num(plotBottom + 16)}
          >
            {truncateLabel(safeLabels[index] ?? String(index + 1), MAX_LABEL_CHARS)}
          </text>
        ))}
    </>
  );

  let plot: ReactNode;

  if (kind === 'bar') {
    const groupWidth = bandWidth * 0.72;
    const slotWidth = groupWidth / Math.max(1, safeSeries.length);
    const barWidth = Math.max(1.5, slotWidth * 0.82);
    const showValues =
      nMax * safeSeries.length <= 24 && barWidth >= 14 && boxHeight >= 120;

    plot = (
      <>
        {axisTicks}
        {safeSeries.map((item, seriesIndex) => (
          <g key={`bars-${seriesIndex}`}>
            {item.values.map((value, index) => {
              if (value === null) return null;
              const x = PAD_LEFT + index * bandWidth + (bandWidth - groupWidth) / 2;
              const barX = x + seriesIndex * slotWidth + (slotWidth - barWidth) / 2;
              const valueY = yAt(value);
              const text = formatNumber(value);
              const above = valueY - 5 >= 8;
              const below = valueY + 12 <= plotBottom;
              // Labels above the bar read best; deep negative bars label below.
              const showText =
                showValues && text.length <= 7 && (value >= 0 ? above : below);
              return (
                <g key={`bar-${seriesIndex}-${index}`}>
                  <path
                    d={barPath(barX, valueY, baseY, barWidth)}
                    fill={colorAt(seriesIndex)}
                  />
                  {showText ? (
                    <text
                      dominantBaseline={value >= 0 ? 'auto' : 'hanging'}
                      fill={token.colorTextSecondary}
                      fontSize={10}
                      style={{ fontFamily: token.fontFamilyCode }}
                      textAnchor="middle"
                      x={num(barX + barWidth / 2)}
                      y={num(value >= 0 ? valueY - 5 : valueY + 5)}
                    >
                      {text}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        ))}
      </>
    );
  } else {
    const drawsDots = nMax <= DOT_LIMIT;
    const fills: ReactNode[] = [];
    const strokes: ReactNode[] = [];

    safeSeries.forEach((item, seriesIndex) => {
      const color = colorAt(seriesIndex);
      const runs: Point[][] = [];
      let run: Point[] = [];
      item.values.forEach((value, index) => {
        if (value === null) {
          if (run.length > 0) runs.push(run);
          run = [];
          return;
        }
        run.push({ x: xAt(index), y: yAt(value) });
      });
      if (run.length > 0) runs.push(run);

      runs.forEach((points, runIndex) => {
        const first = points[0];
        const last = points[points.length - 1];
        if (kind === 'area' && points.length > 1 && first && last) {
          fills.push(
            <path
              key={`area-${seriesIndex}-${runIndex}`}
              d={`${smoothPath(points)} L ${num(last.x)} ${num(baseY)} L ${num(first.x)} ${num(baseY)} Z`}
              fill={color}
              fillOpacity={safeSeries.length > 1 ? 0.12 : 0.18}
            />,
          );
        }
        if (points.length > 1) {
          strokes.push(
            <path
              key={`line-${seriesIndex}-${runIndex}`}
              d={smoothPath(points)}
              fill="none"
              stroke={color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
            />,
          );
        }
        if (drawsDots) {
          strokes.push(
            <g key={`dots-${seriesIndex}-${runIndex}`}>
              {points.map((point, pointIndex) => (
                <circle
                  key={`dot-${seriesIndex}-${runIndex}-${pointIndex}`}
                  cx={num(point.x)}
                  cy={num(point.y)}
                  fill={color}
                  r={2.5}
                />
              ))}
            </g>,
          );
        }
      });
    });

    plot = (
      <>
        {axisTicks}
        {fills}
        {strokes}
      </>
    );
  }

  return (
    <div style={{ width: '100%' }}>
      <svg
        aria-label={`${KIND_LABEL[kind] ?? '图表'}：${safeSeries.map((item) => item.name).join('、')}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        style={{ display: 'block', width: '100%', height: boxHeight }}
        viewBox={`0 0 ${VIEW_WIDTH} ${boxHeight}`}
      >
        {plot}
      </svg>
      {legendRow(
        safeSeries.map((item, index) => ({
          color: colorAt(index),
          label: item.name,
          value: null,
        })),
      )}
    </div>
  );
}

export default UiChart;
