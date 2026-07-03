import { TriangleAlert } from 'lucide-react'
import type { SkillConflict } from '../../core/skillLoader/skillConflictDetector'

interface SkillConflictWarningProps {
  conflicts: SkillConflict[]
}

export function SkillConflictWarning({ conflicts }: SkillConflictWarningProps) {
  if (conflicts.length === 0) return null

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <TriangleAlert className="h-4 w-4" />
        Skill 组合存在冲突
      </div>
      {conflicts.slice(0, 3).map((conflict) => (
        <div key={`${conflict.sourceId}-${conflict.targetId}`}>
          {conflict.sourceTitle} 与 {conflict.targetTitle}
        </div>
      ))}
    </div>
  )
}
