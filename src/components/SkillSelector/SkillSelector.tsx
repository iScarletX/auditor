import { ListChecks } from 'lucide-react'
import type { SkillDefinition } from '../../types/reviewReport.types'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { SkillEditor } from '../SkillEditor/SkillEditor'

interface SkillSelectorProps {
  skills: SkillDefinition[]
  selectedIds: Set<string>
  onToggle: (skillId: string) => void
  onReplaceSelection: (skillIds: string[]) => void
  onSkillAdded: (skill: SkillDefinition) => void
}

const groupLabels: Record<SkillDefinition['source'], string> = {
  universal: '通用 Skill',
  domain: '领域 Skill',
  user: '用户 Skill',
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
  const groups = (['universal', 'domain', 'user'] as const).map((source) => ({
    source,
    items: skills.filter((skill) => skill.source === source),
  }))

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">审查 Skill</h2>
        </div>
        <Badge>{selectedIds.size} 已选</Badge>
      </div>

      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.source} className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {groupLabels[group.source]}
              </h3>
              {group.items.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const groupIds = group.items.map((skill) => skill.id)
                    const others = skills
                      .filter((skill) => skill.source !== group.source && selectedIds.has(skill.id))
                      .map((skill) => skill.id)
                    const allSelected = groupIds.every((id) => selectedIds.has(id))
                    onReplaceSelection(allSelected ? others : [...others, ...groupIds])
                  }}
                >
                  {group.items.every((skill) => selectedIds.has(skill.id)) ? '取消本组' : '选择本组'}
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
                          {skill.domain_specific ? <Badge className="bg-sky-50 text-sky-700">领域</Badge> : null}
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
