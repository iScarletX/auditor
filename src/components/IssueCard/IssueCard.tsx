import { ChevronDown, GitCompareArrows } from 'lucide-react'
import { useState } from 'react'
import type { Issue } from '../../types/reviewReport.types'
import { truncateMiddle } from '../../lib/utils'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'

interface IssueCardProps {
  issue: Issue
  onPreviewFix: (issue: Issue) => void
}

const severityClass = {
  critical: 'border-red-200 bg-red-50 text-red-700',
  major: 'border-amber-200 bg-amber-50 text-amber-800',
  minor: 'border-sky-200 bg-sky-50 text-sky-700',
  info: 'border-slate-200 bg-slate-50 text-slate-600',
}

const severityLabel = {
  critical: '严重',
  major: '较重',
  minor: '轻微',
  info: '提示',
}

export function IssueCard({ issue, onPreviewFix }: IssueCardProps) {
  const [open, setOpen] = useState(false)
  const isSingleDomain = issue.domain_specific && issue.consensus === 'single_model_flag'

  return (
    <article className="rounded-md border border-slate-200 bg-white p-4">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={severityClass[issue.severity]}>{severityLabel[issue.severity]}</Badge>
            <Badge>{issue.skill_id}</Badge>
            <Badge>
              {issue.consensus === 'confirmed'
                ? '多模型确认'
                : issue.consensus === 'static_check_deterministic'
                  ? '静态确定'
                  : '单模型标记'}
            </Badge>
            <span className="text-xs text-slate-500">置信度 {Math.round(issue.confidence * 100)}%</span>
          </div>
          <h3 className="text-sm font-semibold leading-6 text-slate-950">{issue.description}</h3>
        </div>
        <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          {isSingleDomain ? (
            <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
              该问题来自专业领域检查，仅一个模型给出判断，但可能是该模型更专业。
            </div>
          ) : null}
          <div className="grid gap-2 text-xs text-slate-600">
            <div>
              <span className="font-medium text-slate-800">定位：</span>
              {truncateMiddle(
                `${issue.location.anchor_before}${issue.location.matched_text ?? ''}${issue.location.anchor_after}`,
                160,
              )}
            </div>
            <div>
              <span className="font-medium text-slate-800">投票：</span>
              flagged {issue.vote.models_flagged.join(', ') || '-'} / passed {issue.vote.models_passed.join(', ') || '-'}
            </div>
          </div>
          {issue.fix ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => onPreviewFix(issue)}>
              <GitCompareArrows className="h-4 w-4" />
              查看修改建议
            </Button>
          ) : (
            <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
              此问题无具体修改建议，需要人工重新设计。
            </div>
          )}
        </div>
      ) : null}
    </article>
  )
}
