import { AlertTriangle, ChevronRight } from 'lucide-react'
import type { IssueGroup } from '../../types/reviewReport.types'
import { cn } from '../../lib/utils'
import { CATEGORY_LABELS } from '../../lib/categoryLabels'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'

interface IssueCardProps {
  issue: IssueGroup
  onOpen: (issue: IssueGroup) => void
}

const categoryLabel = CATEGORY_LABELS

const severityClass = {
  严重: 'border-red-200 bg-red-50 text-red-700',
  中等: 'border-amber-200 bg-amber-50 text-amber-800',
  轻微: 'border-slate-200 bg-slate-50 text-slate-600',
}

function mergeHint(issue: IssueGroup) {
  if (issue.merge_type === 'same_skill_multi_location') return '多处命中，展开可逐处查看'
  if (issue.merge_type === 'duplicate_content_merge') return '多项检查同时触发'
  if (issue.merge_type === 'systemic_synthesis') return '基于多处线索归纳'
  if (issue.merge_type === 'cross_skill_same_location') return '同一位置多角度发现'
  return null
}

export function IssueCard({ issue, onOpen }: IssueCardProps) {
  const hint = mergeHint(issue)

  return (
    <article
      className={cn(
        'rounded-lg border bg-white p-4',
        issue.profile_conflict ? 'border-violet-200 bg-violet-50/40' : 'border-slate-200',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={severityClass[issue.severity_display]}>{issue.severity_display}</Badge>
            <Badge>{categoryLabel[issue.category]}</Badge>
            <Badge>可信度 {issue.confidence_display}</Badge>
            {hint ? <Badge>{hint}</Badge> : null}
            {issue.profile_conflict ? (
              <Badge className="border-violet-200 bg-violet-50 text-violet-700">
                <AlertTriangle className="mr-1 h-3 w-3" />
                画像待核实
              </Badge>
            ) : null}
          </div>
          <h3 className="text-sm font-semibold leading-6 text-slate-950">{issue.title}</h3>
          {issue.profile_conflict ? (
            <p className="rounded-md border border-violet-200 bg-white px-3 py-2 text-xs leading-5 text-violet-800">
              此判断与文档画像存在矛盾，建议优先核实。{issue.profile_conflict_detail}
            </p>
          ) : null}
          <p className="line-clamp-2 text-xs leading-5 text-slate-600">{issue.description}</p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => onOpen(issue)}>
          查看详情
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </article>
  )
}
