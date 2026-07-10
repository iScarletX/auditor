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
import { emptyPrescription, runConsolidationReview } from './consolidationReviewer'

import { runWithConcurrency } from './concurrencyPool'
import { runDocumentProfile } from './documentProfiler'
import { deduplicateIssues, issuesToRawGroups, mergeConsolidationIntoGroups } from './issueDeduplicator'
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
  /** 最终把关模型可手动指定为任意模型，不局限于已选的检查官；此处传入完整可用模型池作为查找来源 */
  manualConsolidationModelCandidates?: ModelConfig[]
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

/** 审查过程中逐步维护的快照：中途失败/用户主动停止时，拼一份“降级报告”用到的全部已知信息。
 * 设计原则：只读写，不改变现有控制流——每阶段完成后把已知结果存进去，失败时只能拿到“已完成部分”，
 * 不强行补齐未完成部分。 */
interface ReviewSnapshot {
  reviewId: string
  startedAt: number
  scenarioHint: string
  documentProfile: ReviewReport['document_profile'] | null
  checkPlanEntries: ReviewReport['check_plan']
  rawModelOutputs: RawModelOutput[]
  finalIssues: ReviewReport['issues']
  incompleteChecks: ReviewReport['incomplete_checks']
  prescription: ReviewPrescription | null
  fixPlans: ReviewReport['fix_plans']
  modelsUsed: string[]
  expectedSkillModelCalls: number
  actualSkillModelCalls: number
  consolidationModelId: string
  consolidationModelSource: 'auto_selected' | 'user_specified'
}

function buildDegradedReport(snapshot: ReviewSnapshot, stage: string, reason: string): ReviewReport {
  const prescription = snapshot.prescription ?? emptyPrescription(`本次审查在“${stage}”阶段中断，以下为已完成部分的结果。`)
  const report: ReviewReport = {
    meta: {
      review_id: snapshot.reviewId,
      target_sp_hash: '',
      skills_run: snapshot.checkPlanEntries.filter((entry) => entry.decision === 'run').map((entry) => entry.skill_id),
      models_used: snapshot.modelsUsed,
      expected_skill_model_calls: snapshot.expectedSkillModelCalls,
      actual_skill_model_calls: snapshot.actualSkillModelCalls,
      consolidation_model: snapshot.consolidationModelId,
      consolidation_model_source: snapshot.consolidationModelSource,
      timestamp: new Date().toISOString(),
      review_duration_ms: Math.round(performance.now() - snapshot.startedAt),
      scenario_hint: snapshot.scenarioHint,
      degraded: true,
      degraded_reason: reason,
      degraded_stage: stage,
    },
    document_profile: snapshot.documentProfile ?? {
      document_purpose: '未能完成文档画像，无法提供文档理解。',
      output_consumer: '未知',
      declared_exclusions: [],
      internal_conventions: [],
      interaction_mode: 'unknown',
      confidence_note: '审查在建立画像阶段就中断，以下结果不完整。',
    },
    check_plan: snapshot.checkPlanEntries,
    prescription,
    ...(snapshot.fixPlans && snapshot.fixPlans.length > 0 ? { fix_plans: snapshot.fixPlans } : {}),
    incomplete_checks: snapshot.incompleteChecks,
    issues: snapshot.finalIssues,
    raw_model_outputs: snapshot.rawModelOutputs,
    summary: buildSummary(snapshot.finalIssues),
  }
  return JSON.parse(JSON.stringify(report)) as ReviewReport
}

export async function runReview(params: RunReviewParams): Promise<ReviewReport> {
  const models = params.selectedModels.filter((model) => model.selected).slice(0, 3)
  const needsModel = params.selectedSkills.some(requiresModel)

  if (!params.apiKey || models.length < 1) {
    throw new Error('文档画像阶段需要先保存 API Key，并至少选择 1 个模型。')
  }
  if (needsModel && models.length < 1) {
    throw new Error('所选 Skill 包含 LLM 判断项，请选择至少 1 个检查官模型。')
  }

  const consolidationSelection = selectConsolidationModel({
    selectedModels: models,
    manualModelId: params.manualConsolidationModelId,
    manualModelCandidates: params.manualConsolidationModelCandidates,
  })
  const profileModel = consolidationSelection.model ?? models[0]
  if (!profileModel) {
    throw new Error('文档画像阶段找不到可用模型。')
  }

  const snapshot: ReviewSnapshot = {
    reviewId: params.reviewId ?? crypto.randomUUID(),
    startedAt: performance.now(),
    scenarioHint: params.scenarioHint,
    documentProfile: null,
    checkPlanEntries: [],
    rawModelOutputs: [],
    finalIssues: [],
    incompleteChecks: [],
    prescription: null,
    fixPlans: [],
    modelsUsed: models.map((model) => model.modelId),
    expectedSkillModelCalls: 0,
    actualSkillModelCalls: 0,
    consolidationModelId: consolidationSelection.model?.modelId ?? '',
    consolidationModelSource: consolidationSelection.source,
  }

  try {
    return await runReviewInternal(params, models, profileModel, consolidationSelection, snapshot)
  } catch (error) {
    // 画像都还没建立就失败：连 document_profile 这个必填字段都减没有，没任何可展示的部分结果，只能真报错
    if (!snapshot.documentProfile) throw error
    const stage = params.signal?.aborted ? '用户主动停止' : '审查中途失败'
    const reason = params.signal?.aborted
      ? '用户主动停止了审查，下方展示的是停止前已完成的部分结果。'
      : `审查在中途发生错误(${error instanceof Error ? error.message : '未知错误'})，下方展示的是中断前已完成的部分结果。`
    return buildDegradedReport(snapshot, stage, reason)
  }
}

async function runReviewInternal(
  params: RunReviewParams,
  models: ModelConfig[],
  profileModel: ModelConfig,
  consolidationSelection: ReturnType<typeof selectConsolidationModel>,
  snapshot: ReviewSnapshot,
): Promise<ReviewReport> {
  const startedAt = snapshot.startedAt
  const reviewId = snapshot.reviewId
  const rawIssues: Issue[] = []
  const rawModelOutputs: RawModelOutput[] = []
  const allErrors: string[] = []

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
    apiKey: params.apiKey ?? '',
    reviewId,
    signal: params.signal,
  })
  const documentProfile = profileResult.documentProfile
  rawModelOutputs.push(...profileResult.rawModelOutputs)
  snapshot.documentProfile = documentProfile
  snapshot.rawModelOutputs = rawModelOutputs

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
  snapshot.checkPlanEntries = checkPlan.entries

  const { tasks, staticResults } = buildTaskQueue({
    selectedSkills: plannedSkills,
    selectedModels: models,
    targetSp: params.targetSp,
  })
  const modelOutputsBySkill = new Map<string, ModelJudgeOutput[]>()
  const expectedSkillModelCalls = tasks.filter((task) => task.kind === 'llm').length
  snapshot.expectedSkillModelCalls = expectedSkillModelCalls

  await runWithConcurrency(
    tasks,
    6,
    async (task) => {
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
    snapshot.rawModelOutputs = [...rawModelOutputs]
    // 去重还没跑到时就先把当前已发现的原始issue包装进快照(不去重、不合并)，保证中断时不会丢失已发现的问题。
    // 注意：LLM类的found结果要经aggregateVotes投票聊合才能取出，直接用rawIssues不会包含LLM结果(这里static+实时预览投票合并)
    const previewVotedIssues = plannedSkills
      .filter((skill) => skill.execution_mode !== 'static_check')
      .flatMap((skill) => aggregateVotes(modelOutputsBySkill.get(skill.id) ?? []))
    snapshot.finalIssues = issuesToRawGroups([...rawIssues, ...previewVotedIssues])

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
    },
    params.signal,
  )
  if (params.signal?.aborted) {
    throw new DOMException('审查已被用户主动停止', 'AbortError')
  }

  const actualSkillModelCalls = [...modelOutputsBySkill.values()]
    .flat()
    .filter((output) => !output.error)
    .length
  snapshot.actualSkillModelCalls = actualSkillModelCalls
  const incompleteChecks = buildIncompleteChecks({
    selectedSkills: plannedSkills,
    models,
    modelOutputsBySkill,
  })
  snapshot.incompleteChecks = incompleteChecks

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
  // 去重完成后就是一份结构完整的 IssueGroup[]，先写进快照——即使 consolidation 步骤失败，
  // 用户仍能拿到“已发现、去重后但尚未经B1B2把关”的完整问题列表，不是空白一片。
  snapshot.finalIssues = deduplicated.groups
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
      snapshot.rawModelOutputs = [...rawModelOutputs]
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
  // consolidation完成后的结果比去重刚完成时更完整(含B1B2把关+处方)，覆盖前面那个快照点
  snapshot.finalIssues = finalIssues
  snapshot.prescription = prescription

  // 修复方案生成已改为“用户点击修改时才按需生成”(App层调用generateFixPlans)，不再在审查流程里自动跑：
  // 1) 用户只看报告不改时不浪费钱和时间 2) 按需生成时能把完整位置清单传入，要求逐位置覆盖
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
