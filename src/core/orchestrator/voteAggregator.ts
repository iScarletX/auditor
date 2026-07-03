import type { Issue, IssueSeverity } from '../../types/reviewReport.types'
import type { ModelJudgeOutput } from './llmJudgeEngine'

const severityWeight: Record<IssueSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  info: 1,
}

function groupKey(issue: Issue) {
  return `${issue.skill_id}:${issue.id}`
}

function pickRepresentative(issues: Issue[]) {
  const found = issues.filter((issue) => issue.status === 'found')
  if (found.length > 0) {
    return [...found].sort((a, b) => {
      const aWeight = a.severity ? severityWeight[a.severity] : 0
      const bWeight = b.severity ? severityWeight[b.severity] : 0
      return bWeight - aWeight
    })[0]
  }
  return issues[0]
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
    const chosen = pickRepresentative(issues)
    if (!chosen) return
    const flaggedModelIds = [
      ...new Set(
        issues
          .filter((issue) => issue.status === 'found')
          .flatMap((issue) => issue.vote?.models_flagged ?? []),
      ),
    ]
    const passed = validModelIds.filter((modelId) => !flaggedModelIds.includes(modelId))

    if (chosen.status === 'not_applicable') {
      aggregated.push({
        ...chosen,
        vote: {
          models_flagged: [],
          models_passed: [...new Set(issues.flatMap((issue) => issue.vote?.models_passed ?? []))],
        },
        fix: null,
      })
      return
    }

    if (flaggedModelIds.length === 0) return
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
