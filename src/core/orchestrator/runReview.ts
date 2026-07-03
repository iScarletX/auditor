import Ajv from 'ajv'
import reviewReportSchema from '../../schemas/reviewReport.schema.json'
import type {
  Issue,
  IssueCategory,
  IssueSeverity,
  ModelConfig,
  ReviewProgressEvent,
  ReviewReport,
  SkillDefinition,
} from '../../types/reviewReport.types'
import { runConsolidationReview } from './consolidationReviewer'
import { runWithConcurrency } from './concurrencyPool'
import { judgeSkillWithModels } from './llmJudgeEngine'
import { runStaticCheckEngine } from './staticCheckEngine'
import { aggregateVotes } from './voteAggregator'

export interface RunReviewParams {
  targetSp: string
  scenarioHint: string
  selectedSkills: SkillDefinition[]
  selectedModels: ModelConfig[]
  apiKey: string | null
  onProgress?: (event: ReviewProgressEvent) => void
  signal?: AbortSignal
}

const ajv = new Ajv({ strict: false, validateFormats: false })
const validateReviewReport = ajv.compile<ReviewReport>(reviewReportSchema)

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function buildSummary(issues: Issue[]): ReviewReport['summary'] {
  const severityCounts: Record<IssueSeverity, number> = {
    critical: 0,
    major: 0,
    minor: 0,
    info: 0,
  }
  const categoryCounts: Partial<Record<IssueCategory, number>> = {}
  let notApplicableCount = 0

  issues.forEach((issue) => {
    if (issue.status === 'not_applicable') {
      notApplicableCount += 1
      return
    }
    const severity = issue.severity ?? 'major'
    severityCounts[severity] += 1
    categoryCounts[issue.category] = (categoryCounts[issue.category] ?? 0) + 1
  })

  const penalty =
    severityCounts.critical * 25 +
    severityCounts.major * 12 +
    severityCounts.minor * 5 +
    severityCounts.info

  return {
    overall_score: Math.max(0, 100 - penalty),
    issue_count_by_severity: severityCounts,
    issue_count_by_category: categoryCounts,
    not_applicable_count: notApplicableCount,
  }
}

function requiresModel(skill: SkillDefinition) {
  return skill.execution_mode === 'llm_judge' || skill.execution_mode === 'hybrid'
}

async function runSkill(params: {
  skill: SkillDefinition
  targetSp: string
  scenarioHint: string
  models: ModelConfig[]
  apiKey: string | null
  signal?: AbortSignal
}) {
  const staticResult =
    params.skill.execution_mode === 'static_check' || params.skill.execution_mode === 'hybrid'
      ? runStaticCheckEngine(params.skill, params.targetSp)
      : null
  const emittedIssues: Issue[] = []
  const errors: string[] = []

  if (staticResult) {
    emittedIssues.push(...staticResult.issues)
  }

  if (params.skill.execution_mode !== 'static_check') {
    const modelOutputs = await judgeSkillWithModels({
      skill: params.skill,
      targetSp: params.targetSp,
      scenarioHint: params.scenarioHint,
      staticResult,
      models: params.models,
      apiKey: params.apiKey ?? '',
      signal: params.signal,
    })
    modelOutputs.forEach((output) => {
      if (output.error) errors.push(`${params.skill.id} / ${output.modelId}: ${output.error}`)
    })

    const staticIssueIds = new Set(staticResult?.issues.map((issue) => issue.id) ?? [])
    const aggregated = aggregateVotes(modelOutputs).filter((issue) => !staticIssueIds.has(issue.id))
    emittedIssues.push(...aggregated)
  }

  return {
    skill: params.skill,
    issues: emittedIssues,
    errors,
  }
}

export async function runReview(params: RunReviewParams): Promise<ReviewReport> {
  const startedAt = performance.now()
  const allIssues: Issue[] = []
  const allErrors: string[] = []
  const models = params.selectedModels.filter((model) => model.selected).slice(0, 3)
  const totalSteps = params.selectedSkills.length + 1

  if (params.selectedSkills.some(requiresModel) && (!params.apiKey || models.length === 0)) {
    throw new Error('所选 Skill 包含 LLM 判断项，请先保存 API Key 并至少选择 1 个模型。')
  }

  let completed = 0
  await runWithConcurrency(params.selectedSkills, 6, async (skill) => {
    const result = await runSkill({
      skill,
      targetSp: params.targetSp,
      scenarioHint: params.scenarioHint,
      models,
      apiKey: params.apiKey,
      signal: params.signal,
    })
    allIssues.push(...result.issues)
    allErrors.push(...result.errors)
    completed += 1
    params.onProgress?.({
      phase: 'skill_check',
      skillId: skill.id,
      skillTitle: skill.title,
      completed,
      total: totalSteps,
      issues: result.issues,
      errors: [...allErrors],
    })
  })

  const consolidation = await runConsolidationReview({
    targetSp: params.targetSp,
    scenarioHint: params.scenarioHint,
    issues: allIssues.filter((issue) => issue.status === 'found'),
    model: models[0] ?? null,
    apiKey: params.apiKey,
    signal: params.signal,
  })
  const finalIssues = [...allIssues, ...consolidation.new_issues]

  params.onProgress?.({
    phase: 'consolidation',
    skillId: 'consolidation',
    skillTitle: '汇总复核',
    completed: totalSteps,
    total: totalSteps,
    issues: consolidation.new_issues,
    errors: [...allErrors],
  })

  const report: ReviewReport = {
    meta: {
      target_sp_hash: await sha256(params.targetSp),
      scenario_hint: params.scenarioHint,
      skills_run: params.selectedSkills.map((skill) => skill.id),
      models_used: models.map((model) => model.modelId),
      timestamp: new Date().toISOString(),
      review_duration_ms: Math.round(performance.now() - startedAt),
    },
    issues: finalIssues,
    consolidation,
    summary: buildSummary(finalIssues),
  }

  const serializableReport = JSON.parse(JSON.stringify(report)) as ReviewReport
  if (!validateReviewReport(serializableReport)) {
    const message = ajv.errorsText(validateReviewReport.errors)
    throw new Error(`最终 ReviewReport 未通过 Schema 校验：${message}`)
  }

  return serializableReport
}
