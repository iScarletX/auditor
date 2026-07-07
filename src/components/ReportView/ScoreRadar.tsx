import type { DimensionScore } from '../../core/orchestrator/scoreCalculator'

/**
 * 纯 SVG 雷达图：只画参与打分的维度（未检维度显示为灰色缺口标记）。
 * 维度是动态的——雷达图的形状本身反映"这份文档需要查什么"。
 */
export function ScoreRadar({ dimensions }: { dimensions: DimensionScore[] }) {
  const size = 220
  const center = size / 2
  const radius = 78
  const count = dimensions.length
  if (count < 3) return null

  const angleOf = (index: number) => (Math.PI * 2 * index) / count - Math.PI / 2
  const pointOf = (index: number, value: number) => {
    const angle = angleOf(index)
    const r = radius * (value / 100)
    return [center + r * Math.cos(angle), center + r * Math.sin(angle)] as const
  }

  const scoredPolygon = dimensions
    .map((dim, index) => pointOf(index, dim.score ?? 0))
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')

  const rings = [25, 50, 75, 100]

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-52 w-52">
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
      <polygon points={scoredPolygon} fill="rgba(16,185,129,0.18)" stroke="#10b981" strokeWidth="2" />
      {dimensions.map((dim, index) => {
        const [x, y] = pointOf(index, dim.score ?? 0)
        return dim.score === null ? null : (
          <circle key={dim.key} cx={x} cy={y} r="3" fill="#10b981" />
        )
      })}
      {dimensions.map((dim, index) => {
        const [x, y] = pointOf(index, 128)
        const anchor = Math.abs(x - center) < 12 ? 'middle' : x > center ? 'start' : 'end'
        return (
          <text
            key={dim.key}
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-slate-500"
            fontSize="10"
          >
            {dim.label}
            {dim.score === null ? '（未检）' : ` ${dim.score}`}
          </text>
        )
      })}
    </svg>
  )
}
