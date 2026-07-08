import Ajv from 'ajv'
import reviewReportSchema from '../../schemas/reviewReport.schema.json'
import type {
  Issue,
  IssueCategory,
  ModelConfig,
  RawModelOutput,
  ReviewProgressEvent,
  ReviewPrescription,
  ReviewReport,
  SeverityDisplay,
  SkillDefinition,
} from '../../types/reviewReport.types'
import { buildCheckPlan } from './checkPlanner'
import { selectConsolidationModel } from './consolidationModelSelector'
import { runConsolidationReview } from './consolidationReviewer'
import { generateFixPlans } from './fixPlanGenerator'
import { runWithConcurrency } from './concurrencyPool'
import { runDocumentProfile } from './documentProfiler'
import { deduplicateIssues, mergeConsolidationIntoGroups } from './issueDeduplicator'
import { judgeSkillWithModel, type ModelJudgeOutput } from './llmJudgeEngine'
import { runStaticCheckEngine, type StaticCheckResult } from './staticCheckEngine'
import { aggregateVotes } from './voteAggregator'

export interface RunReviewParams {
  targetSp: string
  scenarioHint: string
  selectedSkills: SkillDefinition[]
  selectedModels: ModelConfig[]
  apiKey: string | null
  reviewId?: string
  manualConsolidationModelId?: string | null
  onProgress?: (event: ReviewProgressEvent) => void
  signal?: AbortSignal
}

type ReviewTask =
  | {
      kind: 'static'
      skill: SkillDefinition
      staticResult: StaticCheckResult
    }
  | {
      kind: 'llm'
      skill: SkillDefinition
      model: ModelConfig
      staticResult: StaticCheckResult | null
    }

type ReviewTaskResult =
  | {
      kind: 'static'
      skillId: string
      issues: Issue[]
    }
  | {
      kind: 'llm'
      skillId: string
      output: ModelJudgeOutput
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

function buildSummary(issues: ReviewReport['issues']): ReviewReport['summary'] {
  const severityCounts: Record<SeverityDisplay, number> = {
    严重: 0,
    中等: 0,
    轻微: 0,
  }
  const categoryCounts: Partial<Record<IssueCategory, number>> = {}

  issues.forEach((issue) => {
    severityCounts[issue.severity_display] += 1
    categoryCounts[issue.category] = (categoryCounts[issue.category] ?? 0) + 1
  })

  const penalty = severityCounts.严重 * 25 + severityCounts.中等 * 10 + severityCounts.轻微 * 3
  return {
    overall_score: Math.max(0, 100 - penalty),
    issue_count_by_severity: severityCounts,
    issue_count_by_category: categoryCounts,
  }
}

export function assertPrescriptionConsistency(
  reportPrescription: ReviewPrescription,
  consolidationPrescription: ReviewPrescription,
) {
  if (JSON.stringify(reportPrescription) !== JSON.stringify(consolidationPrescription)) {
    throw new Error('ReviewReport.prescription must match B2 consolidation prescription.')
  }
}

function requiresModel(skill: SkillDefinition) {
  return skill.execution_mode === 'llm_judge' || skill.execution_mode === 'hybrid'
}

function buildTaskQueue(params: {
  selectedSkills: SkillDefinition[]
  selectedModels: ModelConfig[]
  targetSp: string
}) {
  const tasks: ReviewTask[] = []
  const staticResults = new Map<string, StaticCheckResult | null>()

  params.selectedSkills.forEach((skill) => {
    const staticResult =
      skill.execution_mode === 'static_check' || skill.execution_mode === 'hybrid'
        ? runStaticCheckEngine(skill, params.targetSp)
        : null
    staticResults.set(skill.id, staticResult)

    if (skill.execution_mode === 'static_check') {
      if (staticResult) tasks.push({ kind: 'static', skill, staticResult })
      return
    }

    params.selectedModels.forEach((model) => {
      tasks.push({ kind: 'llm', skill, model, staticResult })
    })
  })

  return { tasks, staticResults }
}

function buildIncompleteChecks(params: {
  selectedSkills: SkillDefinition[]
  models: ModelConfig[]
  modelOutputsBySkill: Map<string, ModelJudgeOutput[]>
}): ReviewReport['incomplete_checks'] {
  return params.selectedSkills
    .filter(requiresModel)
    .map((skill) => {
      const outputs = params.modelOutputsBySkill.get(skill.id) ?? []
      const successfulModelIds = new Set(
        outputs.filter((output) => !output.error).map((output) => output.modelId),
      )
      if (successfulModelIds.size > 0) return null

      const expectedModelIds = params.models.map((model) => model.modelId)
      const errorMessages = outputs
        .filter((output) => output.error)
        .map((output) => `${output.modelId}: ${output.error}`)

      return {
        skill_id: skill.id,
        skill_title: skill.title,
        expected_model_ids: expectedModelIds,
        failed_model_ids: expectedModelIds,
        error_messages: errorMessages.length > 0 ? errorMessages : ['未收到任何模型判断结果。'],
      }
    })
    .filter((item): item is ReviewReport['incomplete_checks'][number] => Boolean(item))
}

async function runTask(params: {
  task: ReviewTask
  targetSp: string
  scenarioHint: string
  documentProfile: ReviewReport['document_profile']
  apiKey: string | null
  reviewId: string
  signal?: AbortSignal
}): Promise<ReviewTaskResult> {
  if (params.task.kind === 'static') {
    return {
      kind: 'static',
      skillId: params.task.skill.id,
      issues: params.task.staticResult.issues,
    }
  }

  return {
    kind: 'llm',
    skillId: params.task.skill.id,
    output: await judgeSkillWithModel({
      skill: params.task.skill,
      targetSp: params.targetSp,
      scenarioHint: params.scenarioHint,
      documentProfile: params.documentProfile,
      staticResult: params.task.staticResult,
      model: params.task.model,
      apiKey: params.apiKey ?? '',
      reviewId: params.reviewId,
      signal: params.signal,
    }),
  }
}

export async function runReview(params: RunReviewParams): Promise<ReviewReport> {
  const startedAt = performance.now()
  const reviewId = params.reviewId ?? crypto.randomUUID()
  const rawIssues: Issue[] = []
  const rawModelOutputs: RawModelOutput[] = []
  const allErrors: string[] = []
  const models = params.selectedModels.filter((model) => model.selected).slice(0, 3)
  const needsModel = params.selectedSkills.some(requiresModel)

  if (!params.apiKey || models.length < 1) {
    throw new Error('文档画像阶段需要先保存 API Key，并至少选择 1 个模型。')
  }

  if (needsModel && models.length < 2) {
    throw new Error('所选 Skill 包含 LLM 判断项，请选择 2-3 个检查官模型。')
  }

  const consolidationSelection = selectConsolidationModel({
    selectedModels: models,
    manualModelId: params.manualConsolidationModelId,
  })
  const profileModel = consolidationSelection.model ?? models[0]
  if (!profileModel) {
    throw new Error('文档画像阶段找不到可用模型。')
  }

  // 任务总数在检查计划之后才能精确；这里先按全部选中项估算，计划裁剪后只会提前完成，不会超出
  const estimatedTaskCount = params.selectedSkills.reduce((sum, skill) => {
    if (skill.execution_mode === 'static_check') return sum + 1
    return sum + models.length
  }, 0)
  const totalSteps = estimatedTaskCount + 6
  let completed = 0

  const profileResult = await runDocumentProfile({
    targetSp: params.targetSp,
    model: profileModel,
    apiKey: params.apiKey,
    reviewId,
    signal: params.signal,
  })
  const documentProfile = profileResult.documentProfile
  rawModelOutputs.push(...profileResult.rawModelOutputs)

  completed += 1
  params.onProgress?.({
    phase: 'document_profile',
    label: '正在建立文档画像',
    completed,
    total: totalSteps,
    foundCount: 0,
    errors: [...allErrors],
  })

  // v6 支柱2：检查计划（Triage）——确定性规则 + 画像判断哪些检查项适用，不适用的直接跳过
  const checkPlan = buildCheckPlan({
    targetSp: params.targetSp,
    selectedSkills: params.selectedSkills,
    documentProfile,
  })
  const plannedSkills = checkPlan.skills_to_run

  const { tasks, staticResults } = buildTaskQueue({
    selectedSkills: plannedSkills,
    selectedModels: models,
    targetSp: params.targetSp,
  })
  const modelOutputsBySkill = new Map<string, ModelJudgeOutput[]>()
  const expectedSkillModelCalls = tasks.filter((task) => task.kind === 'llm').length

  await runWithConcurrency(tasks, 6, async (task) => {
    const result = await runTask({
      task,
      targetSp: params.targetSp,
      scenarioHint: params.scenarioHint,
      documentProfile,
      apiKey: params.apiKey,
      reviewId,
      signal: params.signal,
    })

    if (result.kind === 'static') {
      rawIssues.push(...result.issues)
    } else {
      const outputs = modelOutputsBySkill.get(result.skillId) ?? []
      outputs.push(result.output)
      modelOutputsBySkill.set(result.skillId, outputs)
      rawModelOutputs.push(...result.output.raw_model_outputs)
      if (result.output.error) allErrors.push(`${result.skillId} / ${result.output.modelId}: ${result.output.error}`)
    }

    completed += 1
    params.onProgress?.({
      phase: 'skill_check',
      label: task.kind === 'static'
        ? `规则检查：${task.skill.title}`
        : `模型检查：${task.skill.title}`,
      completed,
      total: totalSteps,
      foundCount: rawIssues.filter((issue) => issue.status === 'found').length,
      errors: [...allErrors],
    })

    return result
  })

  const actualSkillModelCalls = [...modelOutputsBySkill.values()]
    .flat()
    .filter((output) => !output.error)
    .length
  const incompleteChecks = buildIncompleteChecks({
    selectedSkills: plannedSkills,
    models,
    modelOutputsBySkill,
  })

  plannedSkills
    .filter((skill) => skill.execution_mode !== 'static_check')
    .forEach((skill) => {
      const modelOutputs = modelOutputsBySkill.get(skill.id) ?? []
      const staticIssueIds = new Set(staticResults.get(skill.id)?.issues.map((issue) => issue.id) ?? [])
      const aggregated = aggregateVotes(modelOutputs).filter((issue) => !staticIssueIds.has(issue.id))
      rawIssues.push(...aggregated)
    })

  completed += 1
  params.onProgress?.({
    phase: 'vote',
    label: '正在进行多模型投票',
    completed,
    total: totalSteps,
    foundCount: rawIssues.filter((issue) => issue.status === 'found').length,
    errors: [...allErrors],
  })

  const deduplicated = await deduplicateIssues(rawIssues, plannedSkills, { embeddingApiKey: params.apiKey })
  completed += 1
  params.onProgress?.({
    phase: 'dedupe',
    label: '正在合并重复问题',
    completed,
    total: totalSteps,
    foundCount: deduplicated.groups.length,
    errors: [...allErrors],
  })

  const consolidation = await runConsolidationReview({
    targetSp: params.targetSp,
    scenarioHint: params.scenarioHint,
    documentProfile,
    issueGroups: deduplicated.groups,
    candidateGroups: deduplicated.candidateGroups,
    model: consolidationSelection.model,
    apiKey: params.apiKey,
    reviewId,
    onRawModelOutputs: (outputs) => {
      rawModelOutputs.push(...outputs)
    },
    signal: params.signal,
  })
  completed += 1
  params.onProgress?.({
    phase: 'consolidation',
    label: '正在进行最终把关',
    completed,
    total: totalSteps,
    foundCount: deduplicated.groups.length,
    errors: [...allErrors],
  })

  const finalIssues = await mergeConsolidationIntoGroups({
    groups: deduplicated.groups,
    consolidation,
    skills: plannedSkills,
    embeddingApiKey: params.apiKey,
  })
  const prescription = consolidation.prescription

  // v6.4 修复方案生成：为每个大问题生成可确认应用的改前/改后文本（失败不阻塞报告）
  completed += 1
  params.onProgress?.({
    phase: 'consolidation',
    label: '正在生成修复方案',
    completed,
    total: totalSteps,
    foundCount: deduplicated.groups.length,
    errors: [...allErrors],
  })
  const fixPlans = await generateFixPlans({
    targetSp: params.targetSp,
    documentProfile,
    prescription,
    model: consolidationSelection.model,
    apiKey: params.apiKey,
    reviewId,
    signal: params.signal,
    onRawModelOutputs: (outputs) => {
      rawModelOutputs.push(...outputs)
    },
  })

  completed += 1
  params.onProgress?.({
    phase: 'complete',
    label: '审查完成',
    completed,
    total: totalSteps,
    foundCount: finalIssues.length,
    errors: [...allErrors],
  })

  const report: ReviewReport = {
    meta: {
      review_id: reviewId,
      target_sp_hash: await sha256(params.targetSp),
      skills_run: plannedSkills.map((skill) => skill.id),
      models_used: models.map((model) => model.modelId),
      expected_skill_model_calls: expectedSkillModelCalls,
      actual_skill_model_calls: actualSkillModelCalls,
      consolidation_model: consolidationSelection.model?.modelId ?? '',
      consolidation_model_source: consolidationSelection.source,
      timestamp: new Date().toISOString(),
      review_duration_ms: Math.round(performance.now() - startedAt),
      scenario_hint: params.scenarioHint,
    },
    document_profile: documentProfile,
    check_plan: checkPlan.entries,
    // ReviewReport.prescription is the persisted copy of B2's prescription; B2 remains the sole source.
    prescription,
    ...(fixPlans.length > 0 ? { fix_plans: fixPlans } : {}),
    incomplete_checks: incompleteChecks,
    issues: finalIssues,
    raw_model_outputs: rawModelOutputs,
    summary: buildSummary(finalIssues),
  }

  const serializableReport = JSON.parse(JSON.stringify(report)) as ReviewReport
  assertPrescriptionConsistency(serializableReport.prescription, consolidation.prescription)
  if (!validateReviewReport(serializableReport)) {
    const message = ajv.errorsText(validateReviewReport.errors)
    throw new Error(`最终 ReviewReport 未通过 Schema 校验：${message}`)
  }

  return serializableReport
}
