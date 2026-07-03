import { ChevronDown, GitCompareArrows } from 'lucide-react'
import { useState } from 'react'
import { truncateMiddle } from '../../lib/utils'
import type { EvidenceType, Issue, ScenarioAssumption } from '../../types/reviewReport.types'
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

const evidenceLabel: Record<EvidenceType, string> = {
  explicit_conflict: '显式冲突',
  explicit_omission: '显式遗漏',
  semantic_inference: '语义推断',
  stylistic_judgment: '风格判断',
}

const scenarioLabel: Record<ScenarioAssumption, string> = {
  inferred_from_text: '从文本推断',
  user_provided: '用户场景',
  worst_case_default: '保守假设',
}

export function IssueCard({ issue, onPreviewFix }: IssueCardProps) {
  const [open, setOpen] = useState(false)
  const isNotApplicable = issue.status === 'not_applicable'
  const severity = issue.severity ?? 'info'
  const isSingleDomain = issue.domain_specific && issue.consensus === 'single_model_flag'
  const flagged = issue.vote?.models_flagged ?? []
  const passed = issue.vote?.models_passed ?? []

  return (
    <article className={`rounded-md border p-4 ${isNotApplicable ? 'border-slate-200 bg-slate-50' : 'border-slate-200 bg-white'}`}>
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {isNotApplicable ? (
              <Badge className="border-slate-200 bg-white text-slate-500">不适用</Badge>
            ) : (
              <Badge className={severityClass[severity]}>{severityLabel[severity]}</Badge>
            )}
            <Badge>{issue.skill_id}</Badge>
            {issue.consensus ? (
              <Badge>
                {issue.consensus === 'confirmed'
                  ? '多模型确认'
                  : issue.consensus === 'static_check_deterministic'
                    ? '静态确定'
                    : '单模型标记'}
              </Badge>
            ) : null}
            {issue.evidence_type ? <Badge>{evidenceLabel[issue.evidence_type]}</Badge> : null}
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
          {isNotApplicable && issue.not_applicable_reason ? (
            <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
              {issue.not_applicable_reason}
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
            {issue.scenario_assumption ? (
              <div>
                <span className="font-medium text-slate-800">场景依据：</span>
                {scenarioLabel[issue.scenario_assumption]}
              </div>
            ) : null}
            <div>
              <span className="font-medium text-slate-800">投票：</span>
              flagged {flagged.join(', ') || '-'} / passed {passed.join(', ') || '-'}
            </div>
          </div>
          {issue.status === 'found' && issue.fix ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => onPreviewFix(issue)}>
              <GitCompareArrows className="h-4 w-4" />
              查看修改建议
            </Button>
          ) : issue.status === 'found' ? (
            <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
              此问题无具体修改建议，需要人工重新设计。
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
