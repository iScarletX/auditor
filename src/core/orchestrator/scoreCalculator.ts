import type {
  CheckPlanReportEntry,
  DocumentProfile,
  IssueCategory,
  IssueGroup,
  SeverityDisplay,
} from '../../types/reviewReport.types'

/**
 * v6.4 计分模块。
 * 设计原则（与用户对齐的硬规则）：
 * 1. 满分 100。
 * 2. 只按"多模型确认"的问题扣分，单模型意见（仅供参考）不参与——防止噪音制造焦虑分。
 * 3. 维度是动态的：某维度检查项全部被跳过 → "未检"，不打分、不参与总分、权重一并剔除。
 * 4. 权重是动态的：由文档画像决定，且每个权重必须带可读的理由（不做黑盒）。
 * 5. 计分归组：步骤逻辑/默认行为/优先级 从"表达清晰"拆出为"流程与逻辑"维度，
 *    与问题性质分类（流程设计）对齐。
 */

export type ScoreDimensionKey =
  | 'clarity'
  | 'flow'
  | 'contract'
  | 'resource'
  | 'interop'
  | 'robustness'
  | 'quality'
  | 'compliance'

export const SCORE_DIMENSION_LABELS: Record<ScoreDimensionKey, string> = {
  clarity: '表达清晰',
  flow: '流程与逻辑',
  contract: '输出规范',
  resource: '篇幅与预算',
  interop: '系统兼容',
  robustness: '抗干扰与安全',
  quality: '质量把关',
  compliance: '合规提示',
}

/** 从"表达清晰"拆入"流程与逻辑"维度的检查项 */
const FLOW_SKILL_IDS = new Set([
  '01_clarity_step_logic',
  '01_clarity_default_behavior',
  '01_clarity_priority_unclear',
])

const SEVERITY_PENALTY: Record<SeverityDisplay, number> = {
  严重: 25,
  中等: 10,
  轻微: 3,
}

export interface DimensionScore {
  key: ScoreDimensionKey
  label: string
  /** null = 未检（该维度检查项全部跳过） */
  score: number | null
  weight: number
  weightReason: string
  ranCheckCount: number
  totalCheckCount: number
  deductions: Array<{ title: string; severity: SeverityDisplay; penalty: number }>
}

export interface ReviewScore {
  total: number
  dimensions: DimensionScore[]
  strengths: string[]
  weaknesses: string[]
}

function dimensionOfSkillId(skillId: string, category: IssueCategory | null): ScoreDimensionKey {
  if (FLOW_SKILL_IDS.has(skillId)) return 'flow'
  if (category) return category as ScoreDimensionKey
  const prefix = skillId.split('_')[0]
  const byPrefix: Record<string, ScoreDimensionKey> = {
    '01': 'clarity',
    '02': 'contract',
    '03': 'resource',
    '04': 'interop',
    '05': 'robustness',
    '06': 'quality',
    '07': 'compliance',
  }
  return byPrefix[prefix] ?? 'quality'
}

function dimensionOfIssue(issue: IssueGroup): ScoreDimensionKey {
  if (issue.related_skill_ids.some((id) => FLOW_SKILL_IDS.has(id))) return 'flow'
  return issue.category as ScoreDimensionKey
}

const MACHINE_CONSUMER_PATTERN = /模型|系统|程序|API|JSON|解析|机器|管线|引擎|engine|model|system|parser|pipeline/i
const CROSS_PLATFORM_PATTERN = /跨平台|多模型|不同模型|可移植|portable|cross-?platform/i
const INTERNAL_INPUT_PATTERN = /内部|受控|不对外|同事|团队内|internal/i
const OUTPUT_LIMIT_PATTERN = /不超过|最多|上限|字以内|词以内|token/i

function buildWeights(params: {
  documentProfile: DocumentProfile | null
  scenarioHint: string
  targetSp: string
}): Record<ScoreDimensionKey, { weight: number; reason: string }> {
  const profileText = [
    params.documentProfile?.document_purpose ?? '',
    params.documentProfile?.output_consumer ?? '',
  ].join(' ')
  const hintText = params.scenarioHint

  const machineConsumer = MACHINE_CONSUMER_PATTERN.test(profileText)
  const crossPlatform = CROSS_PLATFORM_PATTERN.test(params.targetSp) || CROSS_PLATFORM_PATTERN.test(profileText)
  const internalInput = INTERNAL_INPUT_PATTERN.test(hintText) || INTERNAL_INPUT_PATTERN.test(profileText)
  const longDoc = params.targetSp.length > 4000
  const hasOutputLimit = OUTPUT_LIMIT_PATTERN.test(params.targetSp)

  return {
    clarity: { weight: 1.5, reason: '任何提示词话说不清都是根本问题，恒定高权重' },
    flow: { weight: 1.5, reason: '流程死循环、无出口直接影响能否交付，恒定高权重' },
    contract: machineConsumer
      ? { weight: 2.0, reason: '输出交给机器/程序解析，格式契约出错是致命的' }
      : { weight: 1.0, reason: '输出主要给人阅读，格式要求为一般权重' },
    resource: longDoc || hasOutputLimit
      ? { weight: 1.2, reason: longDoc ? '文档篇幅较长，预算问题影响放大' : '声明了输出上限，预算冲突风险上升' }
      : { weight: 0.8, reason: '篇幅适中且无硬性输出上限，风险较低' },
    interop: crossPlatform
      ? { weight: 1.5, reason: '声明了跨模型/跨平台使用，兼容问题影响放大' }
      : { weight: 0.8, reason: '未声明跨平台需求，兼容问题为一般风险' },
    robustness: internalInput
      ? { weight: 0.5, reason: '说明为内部受控输入，注入与异常风险较低' }
      : { weight: 2.0, reason: '未说明输入是否受控，按最坏情况（公开输入）评估' },
    quality: { weight: 1.0, reason: '示例、自检等质量机制，标准权重' },
    compliance: { weight: 0.3, reason: '定位为提示性检查，不构成法律建议，恒定低权重' },
  }
}

export function calculateReviewScore(params: {
  issues: IssueGroup[]
  checkPlan: CheckPlanReportEntry[]
  documentProfile: DocumentProfile | null
  scenarioHint: string
  targetSp: string
  /** 旧报告无 check_plan 时的兜底：用 meta.skills_run 构造覆盖信息，避免全部"未检"显示 0 分 */
  fallbackSkillsRun?: string[]
}): ReviewScore {
  const weights = buildWeights(params)

  // 每个维度的检查覆盖情况（由检查计划实时决定；旧报告用 skills_run 兜底）
  const planEntries: Array<{ skill_id: string; decision: 'run' | 'skip' }> =
    params.checkPlan.length > 0
      ? params.checkPlan
      : (params.fallbackSkillsRun ?? []).map((id) => ({ skill_id: id, decision: 'run' as const }))
  const coverage = new Map<ScoreDimensionKey, { ran: number; total: number }>()
  for (const entry of planEntries) {
    const dim = dimensionOfSkillId(entry.skill_id, null)
    const item = coverage.get(dim) ?? { ran: 0, total: 0 }
    item.total += 1
    if (entry.decision === 'run') item.ran += 1
    coverage.set(dim, item)
  }

  // 只按多模型确认的问题扣分
  const confirmed = params.issues.filter((issue) => issue.confidence_display !== '仅供参考')
  const deductionsByDim = new Map<ScoreDimensionKey, DimensionScore['deductions']>()
  for (const issue of confirmed) {
    const dim = dimensionOfIssue(issue)
    const list = deductionsByDim.get(dim) ?? []
    list.push({
      title: issue.title,
      severity: issue.severity_display,
      penalty: SEVERITY_PENALTY[issue.severity_display],
    })
    deductionsByDim.set(dim, list)
  }

  const dimensions: DimensionScore[] = (Object.keys(SCORE_DIMENSION_LABELS) as ScoreDimensionKey[]).map((key) => {
    const cov = coverage.get(key) ?? { ran: 0, total: 0 }
    const deductions = deductionsByDim.get(key) ?? []
    // 全部跳过或该维度本次没有任何检查项 → 未检
    const score = cov.ran === 0
      ? null
      : Math.max(0, 100 - deductions.reduce((sum, item) => sum + item.penalty, 0))
    return {
      key,
      label: SCORE_DIMENSION_LABELS[key],
      score,
      weight: weights[key].weight,
      weightReason: weights[key].reason,
      ranCheckCount: cov.ran,
      totalCheckCount: cov.total,
      deductions,
    }
  })

  const scored = dimensions.filter((dim) => dim.score !== null)
  const weightSum = scored.reduce((sum, dim) => sum + dim.weight, 0)
  const total = weightSum === 0
    ? 0
    : Math.round(scored.reduce((sum, dim) => sum + (dim.score ?? 0) * dim.weight, 0) / weightSum)

  const strengths = scored
    .filter((dim) => (dim.score ?? 0) >= 90 && dim.ranCheckCount > 0)
    .map((dim) => dim.label)
  const weaknesses = scored
    .filter((dim) => (dim.score ?? 0) < 75)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .map((dim) => dim.label)

  return { total, dimensions, strengths, weaknesses }
}
