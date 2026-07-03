import { GitMerge, TriangleAlert } from 'lucide-react'
import type { ReviewConsolidation } from '../../types/reviewReport.types'
import { Badge } from '../ui/Badge'

interface ConsolidationPanelProps {
  consolidation: ReviewConsolidation | null
}

export function ConsolidationPanel({ consolidation }: ConsolidationPanelProps) {
  if (!consolidation) return null

  const hasContent =
    consolidation.new_issues.length > 0 ||
    consolidation.conflict_notes.length > 0 ||
    consolidation.systemic_findings.length > 0

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitMerge className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">汇总复核</h2>
        </div>
        <Badge>{consolidation.has_new_findings ? '有新增发现' : '无新增发现'}</Badge>
      </div>

      {!hasContent ? (
        <p className="text-sm text-slate-500">未发现修复冲突或系统性新增问题。</p>
      ) : (
        <div className="space-y-3 text-sm">
          {consolidation.conflict_notes.map((note) => (
            <div key={`${note.issue_ids.join('-')}-${note.description}`} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <TriangleAlert className="h-4 w-4" />
                修复冲突
              </div>
              <p>{note.description}</p>
              <p className="mt-1 text-xs text-amber-800">建议：{note.recommendation}</p>
            </div>
          ))}

          {consolidation.systemic_findings.map((finding) => (
            <div key={`${finding.related_issue_ids.join('-')}-${finding.description}`} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium text-slate-950">系统性问题</span>
                <Badge>{finding.severity}</Badge>
              </div>
              <p>{finding.description}</p>
            </div>
          ))}

          {consolidation.new_issues.length > 0 ? (
            <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sky-900">
              汇总复核新增 {consolidation.new_issues.length} 个问题，已合并到问题清单。
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
