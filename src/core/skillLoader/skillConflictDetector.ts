import type { SkillDefinition } from '../../types/reviewReport.types'

export interface SkillConflict {
  sourceId: string
  sourceTitle: string
  targetId: string
  targetTitle: string
}

export function detectSkillConflicts(skills: SkillDefinition[], selectedIds: Set<string>): SkillConflict[] {
  const selected = skills.filter((skill) => selectedIds.has(skill.id))
  const byId = new Map(selected.map((skill) => [skill.id, skill]))
  const conflicts: SkillConflict[] = []

  selected.forEach((skill) => {
    skill.conflicts_with.forEach((targetId) => {
      const target = byId.get(targetId)
      if (!target) return
      const exists = conflicts.some((item) =>
        (item.sourceId === skill.id && item.targetId === target.id) ||
        (item.sourceId === target.id && item.targetId === skill.id),
      )
      if (!exists) {
        conflicts.push({
          sourceId: skill.id,
          sourceTitle: skill.title,
          targetId: target.id,
          targetTitle: target.title,
        })
      }
    })
  })

  return conflicts
}
