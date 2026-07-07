import type { Issue, IssueSeverity } from '../../types/reviewReport.types'
import { isSameConcreteIssue } from './issueSimilarity'
import type { ModelJudgeOutput } from './llmJudgeEngine'

const severityWeight: Record<IssueSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  info: 1,
}

const MIN_SUCCESSFUL_MODELS_FOR_CONFIRMED = 2

function groupKey(issue: Issue) {
  return `${issue.skill_id}:${issue.id}`
}

function isSameConcreteProblem(a: Issue, b: Issue) {
  if (groupKey(a) === groupKey(b)) return true
  return isSameConcreteIssue(a, b, { requireSameSkill: true })
}

function addToGroupedIssues(groups: Issue[][], issue: Issue) {
  const existing = groups.find((items) =>
    items.some((item) => isSameConcreteProblem(item, issue)),
  )
  if (existing) {
    existing.push(issue)
    return
  }
  groups.push([issue])
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
  const groups: Issue[][] = []

  outputs.forEach((output) => {
    if (output.error) return
    output.issues.forEach((issue) => {
      addToGroupedIssues(groups, issue)
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

    if (chosen.status === 'not_applicable') return

    if (flaggedModelIds.length === 0) return
    const confirmed =
      validModelIds.length >= MIN_SUCCESSFUL_MODELS_FOR_CONFIRMED &&
      flaggedModelIds.length > validModelIds.length / 2
    aggregated.push({
      ...chosen,
      consensus: confirmed ? 'confirmed' : 'single_model_flag',
      vote: {
        models_flagged: flaggedModelIds,
        models_passed: passed,
      },
      raw_model_output_ids: [
        ...new Set(issues.flatMap((issue) => issue.raw_model_output_ids ?? [])),
      ],
      fix: chosen.fix ? { ...chosen.fix, fix_requires_review: true as const } : null,
    })
  })

  return aggregated
}
