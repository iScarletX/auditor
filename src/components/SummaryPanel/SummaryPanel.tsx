import { Activity, BarChart3 } from 'lucide-react'
import type { ReviewReport, SkillDefinition } from '../../types/reviewReport.types'
import { Badge } from '../ui/Badge'

interface SummaryPanelProps {
  report: ReviewReport | null
  selectedSkills: SkillDefinition[]
  selectedModelCount: number
}

const categoryLabel: Record<string, string> = {
  engineering_contract: '工程契约',
  instruction_quality: '指令质量',
  structure: '结构',
  io_contract: 'I/O 契约',
  robustness: '稳健性',
  quality_control: '质量控制',
}

export function SummaryPanel({ report, selectedSkills, selectedModelCount }: SummaryPanelProps) {
  const nonStaticSkillCount = selectedSkills.filter((skill) => skill.execution_mode !== 'static_check').length
  const estimatedCalls = nonStaticSkillCount * selectedModelCount
  const estimatedTokens = estimatedCalls * 3500

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-4 flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-950">总览</h2>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md bg-slate-50 p-3">
          <div className="text-xs text-slate-500">总分</div>
          <div className="mt-1 text-3xl font-semibold text-slate-950">
            {report ? Math.round(report.summary.overall_score) : '--'}
          </div>
        </div>
        <div className="rounded-md bg-slate-50 p-3">
          <div className="text-xs text-slate-500">问题数</div>
          <div className="mt-1 text-3xl font-semibold text-slate-950">{report?.issues.length ?? 0}</div>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <Activity className="h-3.5 w-3.5" />
          预估调用
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>非静态 Skill {nonStaticSkillCount}</Badge>
          <Badge>模型 {selectedModelCount}</Badge>
          <Badge>约 {estimatedCalls} 次请求</Badge>
          <Badge>约 {estimatedTokens.toLocaleString()} tokens</Badge>
        </div>
      </div>

      {report ? (
        <div className="mt-4 grid gap-4">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">严重度</h3>
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              {Object.entries(report.summary.issue_count_by_severity).map(([key, value]) => (
                <div key={key} className="rounded-md bg-slate-50 px-2 py-2">
                  <div className="font-semibold text-slate-950">{value}</div>
                  <div className="text-slate-500">{key}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">类别</h3>
            <div className="space-y-1 text-xs text-slate-700">
              {Object.entries(report.summary.issue_count_by_category).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5">
                  <span>{categoryLabel[key] ?? key}</span>
                  <span className="font-semibold text-slate-950">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
