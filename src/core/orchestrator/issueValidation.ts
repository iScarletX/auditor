import type {
  EvidenceType,
  Fix,
  FixAction,
  Issue,
  IssueCategory,
  IssueSeverity,
  IssueStatus,
  ScenarioAssumption,
} from '../../types/reviewReport.types'

export const ISSUE_CATEGORIES: IssueCategory[] = [
  'clarity',
  'contract',
  'resource',
  'interop',
  'robustness',
  'quality',
  'compliance',
]

export const ISSUE_SEVERITIES: IssueSeverity[] = ['critical', 'major', 'minor', 'info']
export const ISSUE_STATUSES: IssueStatus[] = ['found', 'not_applicable']
export const ISSUE_EVIDENCE_TYPES: EvidenceType[] = [
  'explicit_conflict',
  'explicit_omission',
  'semantic_inference',
  'stylistic_judgment',
]
export const ISSUE_SCENARIO_ASSUMPTIONS: ScenarioAssumption[] = [
  'inferred_from_text',
  'user_provided',
  'worst_case_default',
]

const FIX_ACTIONS: FixAction[] = [
  'text_replace',
  'text_insert',
  'text_delete',
  'config_change',
  'constraint_removal',
  'constraint_add',
  'schema_add_field',
  'reorder_section',
]

const MIN_FOUND_DESCRIPTION_LENGTH = 20
const MIN_NOT_APPLICABLE_REASON_LENGTH = 8
const EXCEPTION_DECLARATION_PATTERN = /除外|例外|仅当|不适用于|unless|except/i

// 嵌套字段混淆检测："整体输出是JSON" vs "JSON内某字段内容是自然语言/英文文本"不构成矛盾
const JSON_FORMAT_MENTION_PATTERN = /JSON/i
// 字段级内容描述：提到字段/prompt/键值的内容是自然语言、英文、文本描述类
const INNER_FIELD_CONTENT_PATTERN = /(字段|field|键值|value|prompt|内容)[^。.\n]{0,40}(英文|自然语言|文本|描述|natural language|english|prose)|(英文|自然语言|natural language|english)[^。.\n]{0,20}(prompt|字段|field|描述)/i
// 同层级真矛盾信号：明确否定JSON本身（"不使用JSON""非JSON""纯文本回复"）时不得拦截
const SAME_LEVEL_JSON_NEGATION_PATTERN = /非\s*JSON|不(?:要|用|使用|输出|采用)[^。.\n]{0,10}JSON|避免JSON|instead of JSON|not\s+JSON|纯文本(?:段落|回复|输出)|自然语言段落(?:回复|输出)/i

export interface RawIssueCandidate {
  id?: unknown
  skill_id?: unknown
  category?: unknown
  status?: unknown
  severity?: unknown
  evidence_type?: unknown
  scenario_assumption?: unknown
  not_applicable_reason?: unknown
  location?: {
    anchor_before?: unknown
    anchor_after?: unknown
    matched_text?: unknown
    line_range?: unknown
    ambiguous?: unknown
  }
  description?: unknown
  fix?: unknown
  profile_conflict?: unknown
  profile_conflict_detail?: unknown
}

export interface NormalizeIssueParams {
  value: RawIssueCandidate
  fallbackId: string
  expectedSkillId?: string
  modelId?: string
  executionMode?: Issue['execution_mode']
  domainSpecific?: boolean
  consensus?: Issue['consensus']
  flaggedModelIds?: string[]
  passedModelIds?: string[]
  rawModelOutputIds?: string[]
  fixRequiresReview?: boolean
  /** 原文全文。提供时对 found issue 做锚点存在性硬校验：引用定位不到原文的 issue 直接拒收。 */
  targetSp?: string
}

/**
 * 锚点存在性校验（v6 支柱1）：验证模型引用的原文确实存在于 target_sp。
 * 容忍空白/换行差异（模型常把多行压成单行），但不容忍内容改写。
 * 判定规则：matched_text 命中，或 anchor_before 与 anchor_after 至少一个命中。
 * （双锚点都要求命中会误杀过多——模型经常只有一侧锚点拆得准；
 *   全部定位失败才是编造/改写的强信号。）
 */
function normalizeForAnchorMatch(value: string) {
  return value.replace(/\s+/g, '')
}

export function anchorExistsInTarget(targetSp: string, probe: string | null | undefined): boolean {
  if (!probe) return false
  const trimmed = probe.trim()
  if (!trimmed) return false
  if (targetSp.includes(trimmed)) return true
  // 容忍空白差异：去除所有空白后再比对（仅对足够长的片段，避免短串碰巧命中）
  const compact = normalizeForAnchorMatch(trimmed)
  if (compact.length >= 8) {
    return normalizeForAnchorMatch(targetSp).includes(compact)
  }
  return false
}

export function issueAnchorsLocatable(params: {
  targetSp: string
  anchorBefore: string | null
  anchorAfter: string | null
  matchedText?: string | null
}): boolean {
  if (anchorExistsInTarget(params.targetSp, params.matchedText)) return true
  return (
    anchorExistsInTarget(params.targetSp, params.anchorBefore)
    || anchorExistsInTarget(params.targetSp, params.anchorAfter)
  )
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeLineRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const start = Number(value[0])
  const end = Number(value[1])
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return [Math.max(1, Math.round(start)), Math.max(1, Math.round(end))]
}

function normalizeProfileConflict(value: RawIssueCandidate) {
  if (value.profile_conflict !== true) return {}
  const detail = nonEmptyString(value.profile_conflict_detail)
  return {
    profile_conflict: true as const,
    profile_conflict_detail: detail ?? '该issue被标记为与文档画像存在矛盾，但模型未提供详细说明。',
  }
}

function hasExceptionDeclarationText(parts: Array<string | null | undefined>) {
  return parts.some((part) => Boolean(part && EXCEPTION_DECLARATION_PATTERN.test(part)))
}

function shouldSuppressExceptionConflict(params: {
  skillId: string
  evidenceType: EvidenceType
  anchorBefore: string | null
  anchorAfter: string | null
  matchedText?: string
  description: string
}) {
  if (params.skillId !== '01_clarity_contradiction') return false
  if (params.evidenceType !== 'explicit_conflict') return false
  return hasExceptionDeclarationText([
    params.anchorBefore,
    params.anchorAfter,
    params.matchedText,
    params.description,
  ])
}

/**
 * 嵌套字段混淆兜底防线：通用规则，不硬编码匹配特定文字。
 * 拦截条件（同时满足）：
 * 1. 矛盾/格式一致性类检查项且 evidence_type=explicit_conflict
 * 2. 证据文本同时提到 JSON 整体格式 和 字段级自然语言/英文内容描述
 * 3. 不存在同层级否定JSON的真矛盾信号（"不使用JSON""纯文本回复"等）
 * 注意：这只是代码层安全网，主判断来源仍是工作手册里的层级区分规则。
 */
const NESTED_FIELD_SUPPRESS_SKILL_IDS = new Set([
  '01_clarity_contradiction',
  '02_contract_format_consistency',
  '02_contract_output_format',
])

function shouldSuppressNestedFieldConflict(params: {
  skillId: string
  evidenceType: EvidenceType
  anchorBefore: string | null
  anchorAfter: string | null
  matchedText?: string
  description: string
}) {
  if (!NESTED_FIELD_SUPPRESS_SKILL_IDS.has(params.skillId)) return false
  if (params.evidenceType !== 'explicit_conflict') return false
  const combined = [
    params.anchorBefore ?? '',
    params.anchorAfter ?? '',
    params.matchedText ?? '',
    params.description,
  ].join(' ')
  if (!JSON_FORMAT_MENTION_PATTERN.test(combined)) return false
  if (!INNER_FIELD_CONTENT_PATTERN.test(combined)) return false
  // 存在同层级否定JSON的信号 → 可能是真矛盾，不拦截，交给语义判断
  if (SAME_LEVEL_JSON_NEGATION_PATTERN.test(combined)) return false
  return true
}

export function normalizeFix(value: unknown, fixRequiresReview = true): Fix | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<Fix>
  if (!candidate.action || !FIX_ACTIONS.includes(candidate.action)) return null
  return {
    action: candidate.action,
    target: typeof candidate.target === 'string' ? candidate.target : undefined,
    from: candidate.from,
    to: candidate.to,
    content: typeof candidate.content === 'string' ? candidate.content : undefined,
    fix_requires_review: fixRequiresReview ? true : undefined,
  }
}

export function normalizeStrictIssue(params: NormalizeIssueParams): Issue | null {
  const value = params.value
  if (!value || typeof value !== 'object') return null

  const status = ISSUE_STATUSES.includes(value.status as IssueStatus)
    ? (value.status as IssueStatus)
    : null
  const category = ISSUE_CATEGORIES.includes(value.category as IssueCategory)
    ? (value.category as IssueCategory)
    : null
  const description = nonEmptyString(value.description)

  if (!status || !category || !description) return null

  const rawSkillId = nonEmptyString(value.skill_id)
  const skillId = rawSkillId ?? params.expectedSkillId
  if (!skillId) return null

  const scenarioAssumption = ISSUE_SCENARIO_ASSUMPTIONS.includes(value.scenario_assumption as ScenarioAssumption)
    ? (value.scenario_assumption as ScenarioAssumption)
    : null

  const location = value.location ?? {}
  const anchorBefore = nonEmptyString(location.anchor_before)
  const anchorAfter = nonEmptyString(location.anchor_after)
  const matchedText = nonEmptyString(location.matched_text) ?? undefined
  const profileConflict = normalizeProfileConflict(value)

  if (status === 'not_applicable') {
    const notApplicableReason = nonEmptyString(value.not_applicable_reason)
    if (!notApplicableReason || notApplicableReason.length < MIN_NOT_APPLICABLE_REASON_LENGTH) return null

    return {
      id: nonEmptyString(value.id) ?? params.fallbackId,
      skill_id: skillId,
      category,
      status,
      scenario_assumption: scenarioAssumption ?? undefined,
      not_applicable_reason: notApplicableReason,
      execution_mode: params.executionMode,
      domain_specific: params.domainSpecific,
      consensus: params.consensus ?? 'single_model_flag',
      vote: {
        models_flagged: params.flaggedModelIds ?? [],
        models_passed: params.passedModelIds ?? (params.modelId ? [params.modelId] : []),
      },
      location: {
        anchor_before: anchorBefore ?? '',
        anchor_after: anchorAfter ?? '',
        matched_text: matchedText,
        line_range: normalizeLineRange(location.line_range),
        ambiguous: Boolean(location.ambiguous),
      },
      description,
      raw_model_output_ids: params.rawModelOutputIds ?? [],
      fix: null,
    }
  }

  const severity = ISSUE_SEVERITIES.includes(value.severity as IssueSeverity)
    ? (value.severity as IssueSeverity)
    : null
  const evidenceType = ISSUE_EVIDENCE_TYPES.includes(value.evidence_type as EvidenceType)
    ? (value.evidence_type as EvidenceType)
    : null

  if (!severity || !evidenceType || !scenarioAssumption) return null
  if (!anchorBefore || !anchorAfter) return null
  if (description.length < MIN_FOUND_DESCRIPTION_LENGTH) return null

  // v6 支柱1：锚点存在性硬校验——引用定位不到原文的 found issue 直接拒收，不进报告
  if (params.targetSp && !issueAnchorsLocatable({
    targetSp: params.targetSp,
    anchorBefore,
    anchorAfter,
    matchedText,
  })) {
    return null
  }

  const suppressReason = shouldSuppressExceptionConflict({
    skillId,
    evidenceType,
    anchorBefore,
    anchorAfter,
    matchedText,
    description,
  })
    ? '该候选问题引用了例外声明，属于“一般规则 + 例外条款”结构；即使例外写法不够清楚，也不能在内部矛盾检查项下判定为 explicit_conflict。'
    : shouldSuppressNestedFieldConflict({
        skillId,
        evidenceType,
        anchorBefore,
        anchorAfter,
        matchedText,
        description,
      })
      ? '该候选问题把“外层整体输出格式为JSON”和“JSON内部字段内容为自然语言/英文文本”两个不同层级当成了矛盾；嵌套关系完全兼容，不构成格式冲突。'
      : null

  if (suppressReason) {
    return {
      id: nonEmptyString(value.id) ?? params.fallbackId,
      skill_id: skillId,
      category,
      status: 'not_applicable',
      scenario_assumption: scenarioAssumption,
      not_applicable_reason: suppressReason,
      execution_mode: params.executionMode,
      domain_specific: params.domainSpecific,
      consensus: params.consensus ?? 'single_model_flag',
      vote: {
        models_flagged: [],
        models_passed: params.passedModelIds ?? (params.modelId ? [params.modelId] : []),
      },
      location: {
        anchor_before: anchorBefore,
        anchor_after: anchorAfter,
        matched_text: matchedText,
        line_range: normalizeLineRange(location.line_range),
        ambiguous: Boolean(location.ambiguous),
      },
      description,
      raw_model_output_ids: params.rawModelOutputIds ?? [],
      fix: null,
    }
  }

  return {
    id: nonEmptyString(value.id) ?? params.fallbackId,
    skill_id: skillId,
    category,
    status,
    severity,
    evidence_type: evidenceType,
    scenario_assumption: scenarioAssumption,
    execution_mode: params.executionMode,
    domain_specific: params.domainSpecific,
    consensus: params.consensus ?? 'single_model_flag',
    vote: {
      models_flagged: params.flaggedModelIds ?? (params.modelId ? [params.modelId] : []),
      models_passed: params.passedModelIds ?? [],
    },
    location: {
      anchor_before: anchorBefore,
      anchor_after: anchorAfter,
      matched_text: matchedText,
      line_range: normalizeLineRange(location.line_range),
      ambiguous: Boolean(location.ambiguous),
    },
    description,
    raw_model_output_ids: params.rawModelOutputIds ?? [],
    ...profileConflict,
    fix: normalizeFix(value.fix, params.fixRequiresReview ?? true),
  }
}
