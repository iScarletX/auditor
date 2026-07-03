import { Loader2 } from 'lucide-react'
import type { ReviewProgressEvent } from '../../types/reviewReport.types'

interface ReviewProgressProps {
  running: boolean
  events: ReviewProgressEvent[]
  total: number
}

function phaseLabel(phase: ReviewProgressEvent['phase']) {
  if (phase === 'consolidation') return '汇总复核'
  if (phase === 'complete') return '完成'
  return 'Skill 检查'
}

export function ReviewProgress({ running, events, total }: ReviewProgressProps) {
  const latest = events.at(-1)
  const completed = latest?.completed ?? 0
  const progressTotal = latest?.total ?? total
  const percent = progressTotal === 0 ? 0 : Math.round((completed / progressTotal) * 100)
  const errors = latest?.errors ?? []

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {running ? <Loader2 className="h-4 w-4 animate-spin text-slate-500" /> : null}
          <h2 className="text-sm font-semibold text-slate-950">审查进度</h2>
        </div>
        <span className="text-xs text-slate-500">
          {completed}/{progressTotal}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-3 space-y-2">
        {events.length === 0 ? (
          <p className="text-sm text-slate-500">等待开始审查</p>
        ) : (
          events.map((event) => (
            <div key={`${event.phase}-${event.skillId}-${event.completed}`} className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
              <span className="font-medium text-slate-900">{phaseLabel(event.phase)}：</span>
              <span>{event.skillTitle} 完成，新增 {event.issues.filter((issue) => issue.status === 'found').length} 个问题</span>
            </div>
          ))
        )}
      </div>
      {errors.length > 0 ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {errors.slice(-3).map((error) => (
            <div key={error}>{error}</div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
