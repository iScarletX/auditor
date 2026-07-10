import type {
  ConfidenceDisplay,
  DocumentProfile,
  ModelConfig,
  PrescriptionPriorityAction,
  RawModelOutput,
  ReviewPrescription,
} from '../../types/reviewReport.types'
import { getProviderAdapter } from '../modelProvider/providerAdapter'
import { buildPackageManifest } from './packageManifest'
import { parseJsonObject } from '../responseRepair/autoRepairJson'
import { retryWithErrorFeedback, type RetryRawResponse } from '../responseRepair/retryWithErrorFeedback'

/**
 * v6.4 修复方案生成阶段（B2 之后、报告输出之前）。
 * 为每个大问题（priority_action）生成可确认应用的改前/改后文本：
 * - independent：每处一个独立 edit，可单独应用
 * - joint：多处 edits 构成一组，必须整组应用（apply_mode=group）
 * 硬规则：
 * 1. before_text 必须逐字来自原文（代码层校验，定位不到直接丢弃该 edit）
 * 2. 永不自动应用；应用/编辑/忽略全部由用户决定（fix_requires_review 铁律的延续）
 * 3. 模型说"这个问题无法用改文字解决"时允许 edits 为空并说明原因，禁止硬凑
 */

export interface FixEdit {
  /** 逐字来自原文的待替换文本 */
  before_text: string
  /** 建议的替换文本 */
  after_text: string
  /** 这一处为什么这样改 */
  note: string
}

export interface FixPlan {
  /** 对应 priority_action 的 priority 值 */
  action_priority: number
  /** independent=每处可单独应用；group=必须整组应用（joint 型问题） */
  apply_mode: 'independent' | 'group'
  /** joint 型的整组说明：为什么必须一起改 */
  group_note?: string
  edits: FixEdit[]
  /** edits 为空时必填：为什么无法给出文字级修复 */
  no_fix_reason?: string
  /** S4-⑥守门员：该修法关联的所有issue都是“仅供参考”（未经多模型交叉确认）时标记，提醒用户重点复核 */
  confidence_caveat?: true
}

const FIX_PLAN_SYSTEM_PROMPT = `Butler修复方案生成阶段（S4-⑥ 守门员）

你会收到target_sp全文、document_profile、和一组已确认的大问题（每个含problem_statement现象描述、action_summary建议改法、关联原文位置、证据强度confidence、已裁决矛盾简述conflicts_resolved）。必须先通读problem_statement确认“现在具体错在哪里”，再参考action_summary确认“应该改成什么样”，两者都要结合才能准确定位到该改哪段原文、改成什么。你的任务是为每个大问题生成可直接应用的文字级修复方案。

硬规则：
0. 【逐位置覆盖，最高优先级】每个大问题都带有known_locations字段(已确认的完整原文位置清单)。你必须逐一处理每一个location：能给出文字级修改的，为该位置生成对应的edit(before_text从该位置的matched_text附近原文中选取)；确实无法给出文字级修改的位置，必须在no_fix_reason里逐个点名说明哪几处为什么需要人工处理。严禁只挑一两处处理、其余位置默不作声——用户看到的位置清单和你的修改清单必须能对得上。
1. 每个edit的before_text必须逐字摘自target_sp原文，一字不差，包括标点和空格。系统会校验，对不上会被丢弃。
2. after_text是替换后的完整文本，保持原文的语言风格和格式习惯（document_profile中的internal_conventions），且after_text必须与before_text实质不同（严禁原文原样搬一遍当修改）。
3. 修改必须克制：只改必须改的，不顺手润色无关内容，不改变作者的业务意图。
4. position_relation为joint的问题：多处必须作为一组给出（apply_mode=group），并在group_note说明为什么必须一起改；independent的问题每处单独一个edit（apply_mode=independent）。
5. 如果某个问题无法靠修改提示词文字解决（例如需要业务决策、需要外部配置），edits留空并在no_fix_reason如实说明，禁止硬凑一个没有意义的修改。
6. note必须说清楚这样改解决了什么，一两句话。
7. 矛盾裁决（守门员核心规则）：若同一大问题关联的多个issue对“应该改成什么”有矛盾，采信confidence更高的那一方（“高”>“中”>“仅供参考”），并在note里一句话说明采信理由；conflicts_resolved字段已说明上游复核阶段如何裁决，不要与其矛盾。
8. 若大问题全部关联issue的confidence都是“仅供参考”（未经交叉确认），修改要更保守：宁可少改或留空说明原因，不要为了减完整度硬凑修法。

只输出JSON：
{
  "fix_plans": [
    {
      "action_priority": 1,
      "apply_mode": "independent|group",
      "group_note": "仅apply_mode=group时填写",
      "edits": [
        { "before_text": "逐字原文", "after_text": "替换文本", "note": "为什么这样改（若涉及矛盾裁决请说明采信理由）" }
      ],
      "no_fix_reason": "仅edits为空时填写"
    }
  ]
}`

function normalizeCompact(value: string) {
  return value.replace(/\s+/g, '')
}

/** before_text 必须能在原文中定位（容忍空白差异），否则丢弃该 edit */
export function editLocatable(targetSp: string, beforeText: string): boolean {
  const trimmed = beforeText.trim()
  if (!trimmed) return false
  if (targetSp.includes(trimmed)) return true
  if (trimmed.length >= 8) return normalizeCompact(targetSp).includes(normalizeCompact(trimmed))
  return false
}

interface UnknownFixPlanResult {
  fix_plans?: unknown
}

/** 质量门槛：before_text 与 after_text 实质上一样（忽略前后空白差异）就算“改了等于没改”，模型空转硬凑一个无意义的edit时丢弃 */
function isNoOpEdit(beforeText: string, afterText: string): boolean {
  return normalizeCompact(beforeText) === normalizeCompact(afterText)
}

function normalizeFixPlans(
  raw: unknown,
  targetSp: string,
  validPriorities: Set<number>,
  confidenceCaveatPriorities: Set<number>,
): FixPlan[] {
  if (!Array.isArray(raw)) return []
  const plans: FixPlan[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Record<string, unknown>
    const priority = Number(candidate.action_priority)
    if (!validPriorities.has(priority)) continue
    const applyMode = candidate.apply_mode === 'group' ? 'group' : 'independent'
    const editsRaw = Array.isArray(candidate.edits) ? candidate.edits : []
    const edits: FixEdit[] = []
    for (const editItem of editsRaw) {
      if (!editItem || typeof editItem !== 'object') continue
      const edit = editItem as Record<string, unknown>
      const beforeText = typeof edit.before_text === 'string' ? edit.before_text : ''
      const afterText = typeof edit.after_text === 'string' ? edit.after_text : ''
      const note = typeof edit.note === 'string' ? edit.note : ''
      // 硬校验：before_text 必须能定位到原文；S4-⑥质量门槛：丢弃“改了等于没改”的无意义edit
      if (!beforeText || !afterText || !editLocatable(targetSp, beforeText)) continue
      if (isNoOpEdit(beforeText, afterText)) continue
      edits.push({ before_text: beforeText, after_text: afterText, note })
    }
    const noFixReason = typeof candidate.no_fix_reason === 'string' && candidate.no_fix_reason.trim()
      ? candidate.no_fix_reason.trim()
      : undefined
    // group 型但只剩 1 条 edit 时降级为 independent（组的意义已不存在，但保留 note）
    const effectiveMode = applyMode === 'group' && edits.length <= 1 ? 'independent' : applyMode
    if (edits.length === 0 && !noFixReason) continue
    plans.push({
      action_priority: priority,
      apply_mode: effectiveMode,
      ...(effectiveMode === 'group' && typeof candidate.group_note === 'string' && candidate.group_note.trim()
        ? { group_note: candidate.group_note.trim() }
        : {}),
      edits,
      ...(edits.length === 0 ? { no_fix_reason: noFixReason } : {}),
      ...(confidenceCaveatPriorities.has(priority) ? { confidence_caveat: true as const } : {}),
    })
  }
  return plans
}

/** 一个大问题关联issue中“最强”的证据强度（高>中>仅供参考），给守门员做矛盾裁决的依据 */
export function strongestConfidenceOf(confidences: ConfidenceDisplay[]): ConfidenceDisplay {
  if (confidences.includes('高')) return '高'
  if (confidences.includes('中')) return '中'
  return '仅供参考'
}

/** 每个大问题关联的完整原文位置清单：修复方案生成必须逐位置覆盖，不允许只挑一处应付 */
export interface ActionLocationHint {
  action_priority: number
  locations: Array<{
    /** 原文引用片段(用于定位) */
    matched_text: string
    /** 这一处具体的问题说明 */
    reason: string
  }>
}

function buildUserPrompt(params: {
  targetSp: string
  documentProfile: DocumentProfile
  actions: PrescriptionPriorityAction[]
  prescription: ReviewPrescription
  confidenceByPriority: Map<number, ConfidenceDisplay>
  locationHints?: ActionLocationHint[]
}) {
  // 重要修复：之前problem字段错用action_summary(改法/目的)充当，导致修复方案生成阶段从未看到过“现象本身是什么”，
  // 只能凭一句模粧的“应该改成什么”去推测原文位置，容易找错before_text、生成与问题不相关的修改。
  // 现同时传递problem_statement(现象)、action_summary(改法)、以及完整的locations位置清单，
  // 要求逐位置覆盖，从根本上解决“9处问题只给1条修改”的脱节现象。
  const hintByPriority = new Map((params.locationHints ?? []).map((hint) => [hint.action_priority, hint.locations]))
  const actionsPayload = params.actions.map((action) => ({
    priority: action.priority,
    problem_statement: action.problem_statement,
    action_summary: action.action_summary,
    why: action.why,
    nature: action.nature ?? null,
    position_relation: action.position_relation ?? null,
    grouping_logic: action.grouping_logic ?? null,
    conflicts_resolved: action.conflicts_resolved || null,
    confidence: params.confidenceByPriority.get(action.priority) ?? '中',
    // 完整位置清单：每一处都必须处理(给出edit或说明为什么需要人工判断)
    known_locations: hintByPriority.get(action.priority) ?? [],
  }))
  const manifest = buildPackageManifest(params.targetSp)
  const manifestBlock = manifest ? `<package_manifest>\n${manifest}\n</package_manifest>\n\n` : ''
  return `<document_profile>
${JSON.stringify(params.documentProfile, null, 2)}
</document_profile>

${manifestBlock}<confirmed_problems>
${JSON.stringify(actionsPayload, null, 2)}
</confirmed_problems>

<target_sp>
${params.targetSp}
</target_sp>`
}

export async function generateFixPlans(params: {
  targetSp: string
  documentProfile: DocumentProfile
  prescription: ReviewPrescription
  /** S4-⑥守门员：每个大问题关联issue的最强证据强度，用于矛盾裁决提示与confidence_caveat标记 */
  confidenceByPriority: Map<number, ConfidenceDisplay>
  /** 每个大问题的完整原文位置清单：要求逐位置覆盖，解决“多处问题只给一条修改”的脱节 */
  locationHints?: ActionLocationHint[]
  model: ModelConfig | null
  apiKey: string
  reviewId: string
  signal?: AbortSignal
  onRawModelOutputs?: (outputs: RawModelOutput[]) => void
}): Promise<FixPlan[]> {
  if (!params.model || params.prescription.priority_actions.length === 0) return []
  const schemaName = 'FixPlanResult'
  try {
    const adapter = getProviderAdapter(params.model.provider)
    const result = await retryWithErrorFeedback({
      adapter,
      request: {
        baseUrl: params.model.baseUrl,
        apiKey: params.apiKey,
        modelId: params.model.modelId,
        signal: params.signal,
        messages: [
          { role: 'system', content: FIX_PLAN_SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserPrompt({
              targetSp: params.targetSp,
              documentProfile: params.documentProfile,
              actions: params.prescription.priority_actions,
              prescription: params.prescription,
              confidenceByPriority: params.confidenceByPriority,
              locationHints: params.locationHints,
            }),
          },
        ],
      },
      schemaName,
      validate: (raw) => {
        const parsed = parseJsonObject<UnknownFixPlanResult>(raw)
        if (!Array.isArray(parsed.fix_plans)) throw new Error('缺少 fix_plans 数组')
      },
    })

    const rawModelOutputs: RawModelOutput[] = result.rawResponses.map((response: RetryRawResponse) => ({
      id: crypto.randomUUID(),
      review_id: params.reviewId,
      phase: 'fix_plan',
      skill_id: 'fix_plan_generator',
      skill_title: '修复方案生成',
      model_id: params.model?.modelId ?? '',
      attempt: response.attempt,
      schema_name: schemaName,
      created_at: new Date().toISOString(),
      raw_response_text: response.rawResponseText,
      extracted_content: response.extractedContent,
    }))
    params.onRawModelOutputs?.(rawModelOutputs)

    const parsed = parseJsonObject<UnknownFixPlanResult>(result.content)
    const validPriorities = new Set(params.prescription.priority_actions.map((action) => action.priority))
    // S4-⑥：全部关联issue都是“仅供参考”的大问题，打上confidence_caveat供呈现层提示（代码层计算，不依靠模型自报）
    const confidenceCaveatPriorities = new Set(
      [...params.confidenceByPriority.entries()]
        .filter(([, confidence]) => confidence === '仅供参考')
        .map(([priority]) => priority),
    )
    return normalizeFixPlans(parsed.fix_plans, params.targetSp, validPriorities, confidenceCaveatPriorities)
  } catch {
    // 修复方案生成失败不阻塞报告：返回空，UI 显示"本次未生成修复建议"
    return []
  }
}
