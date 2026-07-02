import type { Issue } from '../../types/reviewReport.types'
import type { ModelJudgeOutput } from './llmJudgeEngine'

function groupKey(issue: Issue) {
  return `${issue.skill_id}:${issue.id}`
}

export function aggregateVotes(outputs: ModelJudgeOutput[]): Issue[] {
  const validModelIds = outputs.filter((output) => !output.error).map((output) => output.modelId)
  const groups = new Map<string, Issue[]>()

  outputs.forEach((output) => {
    if (output.error) return
    output.issues.forEach((issue) => {
      const key = groupKey(issue)
      const items = groups.get(key) ?? []
      items.push(issue)
      groups.set(key, items)
    })
  })

  const aggregated: Issue[] = []
  groups.forEach((issues) => {
    const flaggedModelIds = [...new Set(issues.flatMap((issue) => issue.vote.models_flagged))]
    const chosen = [...issues].sort((a, b) => b.confidence - a.confidence)[0]
    if (!chosen || flaggedModelIds.length === 0) return

    const passed = validModelIds.filter((modelId) => !flaggedModelIds.includes(modelId))
    aggregated.push({
      ...chosen,
      consensus: flaggedModelIds.length >= 2 ? 'confirmed' : 'single_model_flag',
      vote: {
        models_flagged: flaggedModelIds,
        models_passed: passed,
      },
      fix: chosen.fix ? { ...chosen.fix, fix_requires_review: true as const } : null,
    })
  })

  return aggregated
}
