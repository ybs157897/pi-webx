/**
 * 手写 SVG 图表组件（无图表库）。宽度自适应靠 ResizeObserver 测容器宽度，
 * 测不到时退回 `fallbackWidth`；数据为空一律画占位提示，不画空坐标系。
 * @module src/charts
 */

import { useEffect, useId, useRef, useState } from 'react'

/** 图表配色（分类环形图按顺序取用）。 */
export const CHART_COLORS = ['#0071e3', '#34c759', '#ff9500', '#ff3b30', '#af52de', '#5ac8fa', '#ffd60a', '#8e8e93']

/**
 * 测容器宽度做自适应。
 * @param fallback - 首次测量前的兜底宽度，避免首帧宽度 0 画出畸形图。
 * @returns `[ref, width]`。
 */
function useWidth(fallback) {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (node === null) return undefined
    const measure = () => setWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width > 0 ? width : fallback]
}

/** 把最大值抬到刻度好看的整数（1/2/2.5/5/10 的整十倍数）。 */
function niceCeil(value) {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const scaled = value / magnitude
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10
  return step * magnitude
}

/** x 轴标签间隔：保证相邻标签至少 48px，少画几个也不重叠。 */
function labelStep(count, innerWidth, minGap = 48) {
  if (count <= 1) return 1
  return Math.max(1, Math.ceil((count * minGap) / Math.max(1, innerWidth)))
}

/** 空数据占位（图和列表共用同一套文案位置）。 */
export function ChartEmpty({ height = 180, text = '还没有数据' }) {
  return (
    <div className="chart-empty" style={{ minHeight: `${height}px` }}>
      <span>{text}</span>
    </div>
  )
}

/**
 * 折线图（带面积渐变、数值点标注）。
 * @param props - `points` 为 `{ label, value }` 数组；`formatValue` 供轴与点标签用。
 * @returns 图表元素。
 */
export function LineChart({
  points = [],
  height = 190,
  color = CHART_COLORS[0],
  unit = '',
  formatValue = value => String(value),
  empty = '还没有数据',
}) {
  const [ref, width] = useWidth(640)
  const gradientId = useId()
  if (points.length === 0) {
    return <div ref={ref}><ChartEmpty height={height} text={empty} /></div>
  }
  const pad = { top: 22, right: 14, bottom: 26, left: 46 }
  const innerWidth = Math.max(80, width - pad.left - pad.right)
  const innerHeight = Math.max(60, height - pad.top - pad.bottom)
  const max = niceCeil(Math.max(...points.map(point => Number(point.value) || 0)))
  const stepX = points.length > 1 ? innerWidth / (points.length - 1) : 0
  const toX = index => (points.length > 1 ? pad.left + index * stepX : pad.left + innerWidth / 2)
  const toY = value => pad.top + innerHeight - (Number(value) || 0) / max * innerHeight
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${toX(index).toFixed(1)} ${toY(point.value).toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${toX(points.length - 1).toFixed(1)} ${(pad.top + innerHeight).toFixed(1)} L${toX(0).toFixed(1)} ${(pad.top + innerHeight).toFixed(1)} Z`
  const ticks = [0, 0.5, 1]
  const every = labelStep(points.length, innerWidth)
  const showValueLabels = points.length <= 14 && stepX >= 26

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={`折线图${unit === '' ? '' : `，单位${unit}`}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map(ratio => {
          const y = pad.top + innerHeight - ratio * innerHeight
          return (
            <g key={ratio}>
              <line className="chart-grid" x1={pad.left} y1={y} x2={width - pad.right} y2={y} />
              <text className="chart-text" x={pad.left - 8} y={y + 4} textAnchor="end">
                {formatValue(Math.round(max * ratio))}
              </text>
            </g>
          )
        })}
        <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((point, index) => (
          <g key={`${point.label}-${index}`}>
            <circle cx={toX(index)} cy={toY(point.value)} r="3" fill="#fff" stroke={color} strokeWidth="2" />
            {showValueLabels && Number(point.value) > 0 && (
              <text className="chart-text" x={toX(index)} y={toY(point.value) - 9} textAnchor="middle">
                {formatValue(point.value)}
              </text>
            )}
            {(index % every === 0 || index === points.length - 1) && (
              <text className="chart-text" x={toX(index)} y={height - 8} textAnchor="middle">
                {point.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {unit !== '' && <p className="chart-unit">单位：{unit}</p>}
    </div>
  )
}

/**
 * 柱状图（单序列；数值标签在空间不足时自动省略，悬停仍可看数值）。
 * @param props - `bars` 为 `{ label, value }` 数组。
 * @returns 图表元素。
 */
export function BarChart({
  bars = [],
  height = 190,
  color = CHART_COLORS[0],
  unit = '',
  formatValue = value => String(value),
  empty = '还没有数据',
}) {
  const [ref, width] = useWidth(640)
  if (bars.length === 0) {
    return <div ref={ref}><ChartEmpty height={height} text={empty} /></div>
  }
  const pad = { top: 22, right: 14, bottom: 26, left: 46 }
  const innerWidth = Math.max(80, width - pad.left - pad.right)
  const innerHeight = Math.max(60, height - pad.top - pad.bottom)
  const max = niceCeil(Math.max(...bars.map(bar => Number(bar.value) || 0)))
  const slot = innerWidth / bars.length
  const barWidth = Math.max(3, Math.min(30, slot * 0.62))
  const ticks = [0, 0.5, 1]
  const every = labelStep(bars.length, innerWidth)
  const showValueLabels = slot >= 26

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={`柱状图${unit === '' ? '' : `，单位${unit}`}`}>
        {ticks.map(ratio => {
          const y = pad.top + innerHeight - ratio * innerHeight
          return (
            <g key={ratio}>
              <line className="chart-grid" x1={pad.left} y1={y} x2={width - pad.right} y2={y} />
              <text className="chart-text" x={pad.left - 8} y={y + 4} textAnchor="end">
                {formatValue(Math.round(max * ratio))}
              </text>
            </g>
          )
        })}
        {bars.map((bar, index) => {
          const value = Number(bar.value) || 0
          const barHeight = (value / max) * innerHeight
          const x = pad.left + index * slot + (slot - barWidth) / 2
          const y = pad.top + innerHeight - barHeight
          return (
            <g key={`${bar.label}-${index}`}>
              <title>{`${bar.label}：${formatValue(value)}${unit === '' ? '' : ` ${unit}`}`}</title>
              <rect x={x} y={y} width={barWidth} height={Math.max(0, barHeight)} rx={Math.min(4, barWidth / 2)} fill={color} />
              {showValueLabels && value > 0 && (
                <text className="chart-text" x={x + barWidth / 2} y={y - 7} textAnchor="middle">
                  {formatValue(value)}
                </text>
              )}
              {(index % every === 0 || index === bars.length - 1) && (
                <text className="chart-text" x={x + barWidth / 2} y={height - 8} textAnchor="middle">
                  {bar.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {unit !== '' && <p className="chart-unit">单位：{unit}</p>}
    </div>
  )
}

/**
 * 环形图（带右侧图例与中心合计）。
 * @param props - `slices` 为 `{ label, value }` 数组，按顺序上色。
 * @returns 图表元素。
 */
export function DonutChart({
  slices = [],
  size = 176,
  thickness = 22,
  centerLabel = '合计',
  formatValue = value => String(value),
  empty = '还没有数据',
}) {
  const rows = slices.filter(slice => Number(slice.value) > 0)
  const total = rows.reduce((sum, slice) => sum + Number(slice.value), 0)
  if (rows.length === 0 || total <= 0) return <ChartEmpty height={size} text={empty} />
  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  let accumulated = 0

  return (
    <div className="donut">
      <svg width={size} height={size} role="img" aria-label="环形占比图">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(0,0,0,.06)" strokeWidth={thickness} />
          {rows.map((slice, index) => {
            const length = (Number(slice.value) / total) * circumference
            const offset = accumulated
            accumulated += length
            return (
              <circle
                key={`${slice.label}-${index}`}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={thickness}
                strokeDasharray={`${length} ${Math.max(0, circumference - length)}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              >
                <title>{`${slice.label}：${formatValue(slice.value)}（${Math.round((slice.value / total) * 100)}%）`}</title>
              </circle>
            )
          })}
        </g>
        <text className="donut-total" x={size / 2} y={size / 2 - 2} textAnchor="middle">
          {formatValue(total)}
        </text>
        <text className="chart-text" x={size / 2} y={size / 2 + 16} textAnchor="middle">
          {centerLabel}
        </text>
      </svg>
      <ul className="donut-legend">
        {rows.map((slice, index) => (
          <li key={`${slice.label}-${index}`}>
            <span className="donut-swatch" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
            <span className="donut-legend-label">{slice.label}</span>
            <span className="donut-legend-value">{formatValue(slice.value)}</span>
            <span className="donut-legend-percent">{Math.round((slice.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 进度环（完成度）。
 * @param props - `value` / `max` 决定比例，`label` 显示在百分比下方。
 * @returns 环形进度元素。
 */
export function ProgressRing({
  value = 0,
  max = 100,
  size = 104,
  thickness = 11,
  color = CHART_COLORS[1],
  label = '',
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, Number(value) / Number(max))) : 0
  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  return (
    <div className="ring" style={{ width: `${size}px` }}>
      <svg width={size} height={size} role="img" aria-label={`完成度 ${Math.round(ratio * 100)}%`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(0,0,0,.07)" strokeWidth={thickness} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${ratio * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text className="ring-percent" x={size / 2} y={size / 2 + 4} textAnchor="middle">
          {Math.round(ratio * 100)}%
        </text>
      </svg>
      {label !== '' && <p className="ring-label">{label}</p>}
    </div>
  )
}
