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
import { judgeSkillWithModels } from './llmJudgeEngine'
import { runStaticCheckEngine } from './staticCheckEngine'
import { aggregateVotes } from './voteAggregator'

export interface RunReviewParams {
  targetSp: string
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

  issues.forEach((issue) => {
    severityCounts[issue.severity] += 1
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
  }
}

function requiresModel(skill: SkillDefinition) {
  return skill.execution_mode === 'llm_judge' || skill.execution_mode === 'hybrid'
}

export async function runReview(params: RunReviewParams): Promise<ReviewReport> {
  const startedAt = performance.now()
  const allIssues: Issue[] = []
  const errors: string[] = []
  const models = params.selectedModels.filter((model) => model.selected)

  if (params.selectedSkills.some(requiresModel) && (!params.apiKey || models.length === 0)) {
    throw new Error('所选 Skill 包含 LLM 判断项，请先保存 API Key 并至少选择 1 个模型。')
  }

  for (let index = 0; index < params.selectedSkills.length; index += 1) {
    const skill = params.selectedSkills[index]
    const staticResult =
      skill.execution_mode === 'static_check' || skill.execution_mode === 'hybrid'
        ? runStaticCheckEngine(skill, params.targetSp)
        : null
    const emittedIssues: Issue[] = []

    if (staticResult) {
      allIssues.push(...staticResult.issues)
      emittedIssues.push(...staticResult.issues)
    }

    if (skill.execution_mode !== 'static_check') {
      const modelOutputs = await judgeSkillWithModels({
        skill,
        targetSp: params.targetSp,
        staticResult,
        models,
        apiKey: params.apiKey ?? '',
        signal: params.signal,
      })
      modelOutputs.forEach((output) => {
        if (output.error) errors.push(`${skill.id} / ${output.modelId}: ${output.error}`)
      })

      const staticIssueIds = new Set(staticResult?.issues.map((issue) => issue.id) ?? [])
      const aggregated = aggregateVotes(modelOutputs).filter((issue) => !staticIssueIds.has(issue.id))
      allIssues.push(...aggregated)
      emittedIssues.push(...aggregated)
    }

    params.onProgress?.({
      skillId: skill.id,
      skillTitle: skill.title,
      completed: index + 1,
      total: params.selectedSkills.length,
      issues: emittedIssues,
      errors: [...errors],
    })
  }

  const report: ReviewReport = {
    meta: {
      target_sp_hash: await sha256(params.targetSp),
      skills_run: params.selectedSkills.map((skill) => skill.id),
      models_used: models.map((model) => model.modelId),
      timestamp: new Date().toISOString(),
      review_duration_ms: Math.round(performance.now() - startedAt),
    },
    issues: allIssues,
    summary: buildSummary(allIssues),
  }

  if (!validateReviewReport(report)) {
    const message = ajv.errorsText(validateReviewReport.errors)
    throw new Error(`最终 ReviewReport 未通过 Schema 校验：${message}`)
  }

  return report
}
