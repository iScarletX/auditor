import { useMemo, useState } from 'react'
import type { Issue, IssueSeverity } from '../../types/reviewReport.types'
import { Button } from '../ui/Button'
import { IssueCard } from '../IssueCard/IssueCard'

interface IssueListProps {
  issues: Issue[]
  onPreviewFix: (issue: Issue) => void
}

const filters: Array<{ id: IssueSeverity | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'critical', label: '严重' },
  { id: 'major', label: '较重' },
  { id: 'minor', label: '轻微' },
  { id: 'info', label: '提示' },
]

export function IssueList({ issues, onPreviewFix }: IssueListProps) {
  const [filter, setFilter] = useState<IssueSeverity | 'all'>('all')
  const visibleIssues = useMemo(
    () => (filter === 'all' ? issues : issues.filter((issue) => issue.severity === filter)),
    [filter, issues],
  )

  return (
    <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-950">问题清单</h2>
        <div className="flex flex-wrap gap-1">
          {filters.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={filter === item.id ? 'primary' : 'ghost'}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>

      {visibleIssues.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
          暂无问题
        </div>
      ) : (
        <div className="space-y-3">
          {visibleIssues.map((issue) => (
            <IssueCard key={`${issue.skill_id}-${issue.id}-${issue.description}`} issue={issue} onPreviewFix={onPreviewFix} />
          ))}
        </div>
      )}
    </section>
  )
}
