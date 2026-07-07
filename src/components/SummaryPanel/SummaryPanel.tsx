import { Activity } from 'lucide-react'
import { useMemo } from 'react'
import { buildCheckPlan } from '../../core/orchestrator/checkPlanner'
import type { ReviewReport, SkillDefinition } from '../../types/reviewReport.types'
import { Badge } from '../ui/Badge'

interface SummaryPanelProps {
  report: ReviewReport | null
  selectedSkills: SkillDefinition[]
  selectedModelCount: number
  /** 当前输入的 prompt：预估基于智能裁剪后的真实数量，而不是全选数量 */
  targetSp: string
}

export function SummaryPanel({ report, selectedSkills, selectedModelCount, targetSp }: SummaryPanelProps) {
  // 预估必须基于智能裁剪后的真实执行数，避免"45已选/138次请求"这种与实际不符的数字
  const plannedSkills = useMemo(() => {
    if (!targetSp.trim() || selectedSkills.length === 0) return selectedSkills
    return buildCheckPlan({ targetSp, selectedSkills, documentProfile: null }).skills_to_run
  }, [targetSp, selectedSkills])

  const nonStaticSkillCount = plannedSkills.filter((skill) => skill.execution_mode !== 'static_check').length
  const consolidationCalls = selectedModelCount >= 1 ? 3 : 0
  const estimatedCalls = nonStaticSkillCount * selectedModelCount + consolidationCalls
  const estimatedTokens = estimatedCalls * 3000
  const estimatedMinutes = Math.max(1, Math.ceil(estimatedCalls / 6))

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-950">预估</h2>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge>实际执行 {nonStaticSkillCount} 项</Badge>
        <Badge>检查官 {selectedModelCount}</Badge>
        <Badge>约 {estimatedCalls} 次请求</Badge>
        <Badge>约 {estimatedMinutes} 分钟</Badge>
        <Badge>约 {estimatedTokens.toLocaleString()} tokens</Badge>
      </div>
      <div className="mt-3 text-xs leading-5 text-slate-500">
        预估基于智能模式裁剪后的真实执行数量，已包含文档画像、独立复核和最终把关调用。
      </div>
      {report ? (
        <div className="mt-3 text-xs leading-5 text-slate-500">
          上次报告：{report.prescription.priority_actions.length} 个主要问题，检测记录 {report.issues.length} 条。
        </div>
      ) : null}
    </section>
  )
}
