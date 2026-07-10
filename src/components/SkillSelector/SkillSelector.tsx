import { ChevronDown, ChevronRight, ListChecks } from 'lucide-react'
import { useMemo, useState } from 'react'
import { buildCheckPlan } from '../../core/orchestrator/checkPlanner'
import { detectSkillConflicts } from '../../core/skillLoader/skillConflictDetector'
import type { IssueCategory, SkillDefinition } from '../../types/reviewReport.types'
import { SkillConflictWarning } from '../SkillConflictWarning/SkillConflictWarning'
import { SkillEditor } from '../SkillEditor/SkillEditor'
import { Badge } from '../ui/Badge'
import { CATEGORY_LABELS } from '../../lib/categoryLabels'

interface SkillSelectorProps {
  skills: SkillDefinition[]
  selectedIds: Set<string>
  recommendedDomainIds: Set<string>
  onToggle: (skillId: string) => void
  onSkillAdded: (skill: SkillDefinition) => void
  /** 当前输入的 prompt：用于实时预判智能模式会执行/跳过哪些检查项 */
  targetSp: string
}

const categoryOrder: IssueCategory[] = ['clarity', 'contract', 'resource', 'interop', 'robustness', 'quality', 'compliance']

const categoryLabels = CATEGORY_LABELS

function modeLabel(mode: SkillDefinition['execution_mode']) {
  if (mode === 'static_check') return '静态'
  if (mode === 'hybrid') return '混合'
  return 'LLM'
}

export function SkillSelector({
  skills,
  selectedIds,
  recommendedDomainIds,
  onToggle,
  onSkillAdded,
  targetSp,
}: SkillSelectorProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [domainOpen, setDomainOpen] = useState(false)
  const [skipOpen, setSkipOpen] = useState(false)
  const universalSkills = skills.filter((skill) => skill.source === 'universal')
  const domainSkills = skills.filter((skill) => skill.source === 'domain')
  const userSkills = skills.filter((skill) => skill.source === 'user')
  const conflicts = detectSkillConflicts(skills, selectedIds)

  // 实时预判：输入 prompt 后立刻用确定性规则预计算本次会执行/跳过哪些（不调模型）
  const previewPlan = useMemo(() => {
    if (!targetSp.trim()) return null
    const selected = skills.filter((skill) => selectedIds.has(skill.id))
    if (selected.length === 0) return null
    return buildCheckPlan({ targetSp, selectedSkills: selected, documentProfile: null })
  }, [targetSp, skills, selectedIds])

  const categoryStats = categoryOrder.map((category) => {
    const items = universalSkills.filter((skill) => skill.category === category)
    const selectedCount = items.filter((skill) => selectedIds.has(skill.id)).length
    return { category, items, selectedCount }
  })

  return (
    <section className="rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100 p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">审查项</h2>
        </div>
        <Badge>{selectedIds.size} 已选</Badge>
      </div>

      <div className="space-y-3">
        <SkillConflictWarning conflicts={conflicts} />

        <div className="rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
          <div className="text-sm font-medium text-emerald-900">智能模式（默认）</div>
          {previewPlan ? (
            <div className="mt-1.5">
              <p className="text-xs leading-5 text-emerald-800">
                已分析当前文档：本次将执行 <span className="font-semibold">{previewPlan.skills_to_run.length}</span> 项检查
                {previewPlan.skipped_count > 0 ? (
                  <>
                    ，跳过 <span className="font-semibold">{previewPlan.skipped_count}</span> 项不适用的
                  </>
                ) : null}
                。
              </p>
              {previewPlan.skipped_count > 0 ? (
                <button
                  type="button"
                  className="mt-1 flex items-center gap-1 text-xs text-emerald-700 underline decoration-dotted underline-offset-2"
                  onClick={() => setSkipOpen((value) => !value)}
                >
                  查看跳过原因
                  {skipOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
              ) : null}
              {skipOpen ? (
                <ul className="mt-1.5 space-y-1 text-xs leading-5 text-emerald-800">
                  {previewPlan.entries
                    .filter((entry) => entry.decision === 'skip')
                    .map((entry) => (
                      <li key={entry.skill_id}>
                        <span className="font-medium">{entry.skill_title}</span>：{entry.reason}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-xs leading-5 text-emerald-800">
              粘贴 prompt 后，这里会实时显示本次会执行哪些检查、跳过哪些及原因。
            </p>
          )}
        </div>

        <div className="rounded-md border border-slate-200">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-900"
            onClick={() => setDomainOpen((value) => !value)}
          >
            领域检查
            <ChevronDown className={`h-4 w-4 text-slate-400 transition ${domainOpen ? 'rotate-180' : ''}`} />
          </button>
          {domainOpen ? (
            <div className="space-y-2 border-t border-slate-200 p-3">
              {domainSkills.length === 0 ? (
                <p className="text-xs text-slate-500">暂无领域 Skill</p>
              ) : (
                domainSkills.map((skill) => (
                  <label key={skill.id} className="flex items-start gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(skill.id)}
                      onChange={() => onToggle(skill.id)}
                      className="mt-1"
                    />
                  <span>
                      <span className="font-medium text-slate-900">{skill.title}</span>
                      {recommendedDomainIds.has(skill.id) ? (
                        <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                          推荐
                        </span>
                      ) : null}
                      <span className="mt-1 block text-xs text-slate-500">{skill.description}</span>
                    </span>
                  </label>
                ))
              )}
              <SkillEditor label="上传领域 Skill" onSkillAdded={onSkillAdded} />
            </div>
          ) : null}
        </div>

        <div className="rounded-md border border-slate-200">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-900"
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            高级：手动选择检查项
            <ChevronDown className={`h-4 w-4 text-slate-400 transition ${advancedOpen ? 'rotate-180' : ''}`} />
          </button>
          {advancedOpen ? (
            <div className="max-h-[420px] space-y-4 overflow-auto border-t border-slate-200 p-3">
              {categoryStats.map(({ category, items }) => (
                <div key={category} className="space-y-2">
                  <div className="text-xs font-semibold text-slate-500">{categoryLabels[category]}</div>
                  {items.map((skill) => (
                    <label key={skill.id} className="block rounded-md border border-slate-200 p-2 text-xs">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(skill.id)}
                          onChange={() => onToggle(skill.id)}
                          className="mt-0.5"
                        />
                        <div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-slate-900">{skill.title}</span>
                            <Badge>{modeLabel(skill.execution_mode)}</Badge>
                          </div>
                          <div className="mt-1 leading-5 text-slate-600">{skill.description}</div>
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              ))}
              {userSkills.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-500">自定义 Skill</div>
                  {userSkills.map((skill) => (
                    <label key={skill.id} className="flex items-start gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(skill.id)}
                        onChange={() => onToggle(skill.id)}
                        className="mt-0.5"
                      />
                      <span>{skill.title}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              <SkillEditor label="上传通用 Skill" onSkillAdded={onSkillAdded} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
