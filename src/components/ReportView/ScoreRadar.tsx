import type { DimensionScore } from '../../core/orchestrator/scoreCalculator'

/**
 * 纯 SVG 雷达图：只画参与打分的维度（未检维度显示为灰色缺口标记）。
 * 维度是动态的——雷达图的形状本身反映"这份文档需要查什么"。
 *
 * 修复历史bug：原来画布 220x220、标签半径 128 直接超出画布导致文字被裁切显示不全。
 * 现加大画布并为标签预留边距；标签过长时截断，鼠标悬停(SVG title)看完整名称。
 */
export function ScoreRadar({ dimensions }: { dimensions: DimensionScore[] }) {
  const size = 300
  const center = size / 2
  const radius = 88
  const labelRadius = 122
  const count = dimensions.length
  if (count < 3) return null

  const angleOf = (index: number) => (Math.PI * 2 * index) / count - Math.PI / 2
  const pointOf = (index: number, value: number, r = radius) => {
    const angle = angleOf(index)
    const distance = r * (value / 100)
    return [center + distance * Math.cos(angle), center + distance * Math.sin(angle)] as const
  }

  const scoredPolygon = dimensions
    .map((dim, index) => pointOf(index, dim.score ?? 0))
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')

  const rings = [25, 50, 75, 100]

  const shortLabel = (label: string) => (label.length > 6 ? `${label.slice(0, 5)}…` : label)

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-64 w-64">
      <defs>
        <linearGradient id="radar-fill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#059669" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#34d399" stopOpacity="0.12" />
        </linearGradient>
        <linearGradient id="radar-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#059669" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
      </defs>
      {rings.map((ring) => (
        <polygon
          key={ring}
          points={dimensions
            .map((_, index) => pointOf(index, ring))
            .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
            .join(' ')}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="1"
        />
      ))}
      {dimensions.map((_, index) => {
        const [x, y] = pointOf(index, 100)
        return <line key={index} x1={center} y1={center} x2={x} y2={y} stroke="#e2e8f0" strokeWidth="1" />
      })}
      <polygon points={scoredPolygon} fill="url(#radar-fill)" stroke="url(#radar-stroke)" strokeWidth="2" />
      {dimensions.map((dim, index) => {
        const [x, y] = pointOf(index, dim.score ?? 0)
        return dim.score === null ? null : (
          <circle key={dim.key} cx={x} cy={y} r="3" fill="#059669" />
        )
      })}
      {dimensions.map((dim, index) => {
        const [x, y] = pointOf(index, 100, labelRadius)
        const anchor = Math.abs(x - center) < 14 ? 'middle' : x > center ? 'start' : 'end'
        return (
          <text
            key={dim.key}
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-slate-500"
            fontSize="11"
          >
            <title>{dim.label}{dim.score === null ? '（未检）' : ` ${dim.score}分`}</title>
            {shortLabel(dim.label)}
            {dim.score === null ? '' : ` ${dim.score}`}
          </text>
        )
      })}
    </svg>
  )
}
