import { ListChecks } from 'lucide-react'
import { detectSkillConflicts } from '../../core/skillLoader/skillConflictDetector'
import type { IssueCategory, SkillDefinition } from '../../types/reviewReport.types'
import { SkillConflictWarning } from '../SkillConflictWarning/SkillConflictWarning'
import { SkillEditor } from '../SkillEditor/SkillEditor'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'

interface SkillSelectorProps {
  skills: SkillDefinition[]
  selectedIds: Set<string>
  onToggle: (skillId: string) => void
  onReplaceSelection: (skillIds: string[]) => void
  onSkillAdded: (skill: SkillDefinition) => void
}

const categoryOrder: IssueCategory[] = [
  'clarity',
  'contract',
  'resource',
  'interop',
  'robustness',
  'quality',
  'compliance',
]

const categoryLabels: Record<IssueCategory, string> = {
  clarity: '清晰度与一致性',
  contract: '输入输出契约',
  resource: '资源与执行',
  interop: '兼容性',
  robustness: '稳健性与安全',
  quality: '质量控制',
  compliance: '合规',
}

const sourceLabels: Record<SkillDefinition['source'], string> = {
  universal: '通用',
  domain: '领域',
  user: '自定义',
}

function modeLabel(mode: SkillDefinition['execution_mode']) {
  if (mode === 'static_check') return '静态'
  if (mode === 'hybrid') return '混合'
  return 'LLM'
}

export function SkillSelector({
  skills,
  selectedIds,
  onToggle,
  onReplaceSelection,
  onSkillAdded,
}: SkillSelectorProps) {
  const groups = categoryOrder.map((category) => ({
    category,
    items: skills.filter((skill) => skill.category === category),
  }))
  const conflicts = detectSkillConflicts(skills, selectedIds)

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">审查 Skill</h2>
        </div>
        <Badge>{selectedIds.size} 已选</Badge>
      </div>

      <div className="mb-3 flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onReplaceSelection(skills.filter((skill) => skill.source === 'universal').map((skill) => skill.id))}
        >
          全选通用
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onReplaceSelection([])}>
          清空
        </Button>
      </div>

      <div className="space-y-4">
        <SkillConflictWarning conflicts={conflicts} />
        {groups.map((group) => (
          <div key={group.category} className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {categoryLabels[group.category]}
              </h3>
              {group.items.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const groupIds = group.items.map((skill) => skill.id)
                    const others = skills
                      .filter((skill) => skill.category !== group.category && selectedIds.has(skill.id))
                      .map((skill) => skill.id)
                    const allSelected = groupIds.every((id) => selectedIds.has(id))
                    onReplaceSelection(allSelected ? others : [...others, ...groupIds])
                  }}
                >
                  {group.items.every((skill) => selectedIds.has(skill.id)) ? '取消本类' : '选择本类'}
                </Button>
              ) : null}
            </div>

            {group.items.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500">
                暂无内容
              </div>
            ) : (
              <div className="space-y-2">
                {group.items.map((skill) => (
                  <label
                    key={skill.id}
                    className="block rounded-md border border-slate-200 p-3 transition hover:border-slate-300 hover:bg-slate-50"
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(skill.id)}
                        onChange={() => onToggle(skill.id)}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-slate-900">{skill.title}</span>
                          <Badge>{modeLabel(skill.execution_mode)}</Badge>
                          <Badge>{sourceLabels[skill.source]}</Badge>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-slate-600">{skill.description}</p>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}

        <SkillEditor onSkillAdded={onSkillAdded} />
      </div>
    </section>
  )
}
