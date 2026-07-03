import { useMemo, useState } from 'react'
import type { Issue, IssueSeverity } from '../../types/reviewReport.types'
import { IssueCard } from '../IssueCard/IssueCard'
import { Button } from '../ui/Button'

interface IssueListProps {
  issues: Issue[]
  onPreviewFix: (issue: Issue) => void
}

type IssueFilter = IssueSeverity | 'all' | 'found' | 'not_applicable'

const filters: Array<{ id: IssueFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'found', label: '仅问题' },
  { id: 'not_applicable', label: '不适用' },
  { id: 'critical', label: '严重' },
  { id: 'major', label: '较重' },
  { id: 'minor', label: '轻微' },
  { id: 'info', label: '提示' },
]

export function IssueList({ issues, onPreviewFix }: IssueListProps) {
  const [filter, setFilter] = useState<IssueFilter>('all')
  const visibleIssues = useMemo(() => {
    if (filter === 'all') return issues
    if (filter === 'found') return issues.filter((issue) => issue.status === 'found')
    if (filter === 'not_applicable') return issues.filter((issue) => issue.status === 'not_applicable')
    return issues.filter((issue) => issue.status === 'found' && issue.severity === filter)
  }, [filter, issues])

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
          暂无内容
        </div>
      ) : (
        <div className="space-y-3">
          {visibleIssues.map((issue) => (
            <IssueCard
              key={`${issue.skill_id}-${issue.id}-${issue.status}-${issue.description}`}
              issue={issue}
              onPreviewFix={onPreviewFix}
            />
          ))}
        </div>
      )}
    </section>
  )
}
