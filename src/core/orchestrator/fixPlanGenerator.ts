import type {
  DocumentProfile,
  ModelConfig,
  PrescriptionPriorityAction,
  RawModelOutput,
  ReviewPrescription,
} from '../../types/reviewReport.types'
import { getProviderAdapter } from '../modelProvider/providerAdapter'
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
}

const FIX_PLAN_SYSTEM_PROMPT = `Butler修复方案生成阶段

你会收到target_sp全文、document_profile、和一组已确认的大问题（每个含说明与关联原文位置）。你的任务是为每个大问题生成可直接应用的文字级修复方案。

硬规则：
1. 每个edit的before_text必须逐字摘自target_sp原文，一字不差，包括标点和空格。系统会校验，对不上会被丢弃。
2. after_text是替换后的完整文本，保持原文的语言风格和格式习惯（document_profile中的internal_conventions）。
3. 修改必须克制：只改必须改的，不顺手润色无关内容，不改变作者的业务意图。
4. position_relation为joint的问题：多处必须作为一组给出（apply_mode=group），并在group_note说明为什么必须一起改；independent的问题每处单独一个edit（apply_mode=independent）。
5. 如果某个问题无法靠修改提示词文字解决（例如需要业务决策、需要外部配置），edits留空并在no_fix_reason如实说明，禁止硬凑一个没有意义的修改。
6. note必须说清楚这样改解决了什么，一两句话。

只输出JSON：
{
  "fix_plans": [
    {
      "action_priority": 1,
      "apply_mode": "independent|group",
      "group_note": "仅apply_mode=group时填写",
      "edits": [
        { "before_text": "逐字原文", "after_text": "替换文本", "note": "为什么这样改" }
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

function normalizeFixPlans(raw: unknown, targetSp: string, validPriorities: Set<number>): FixPlan[] {
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
      // 硬校验：before_text 必须能定位到原文
      if (!beforeText || !afterText || !editLocatable(targetSp, beforeText)) continue
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
    })
  }
  return plans
}

function buildUserPrompt(params: {
  targetSp: string
  documentProfile: DocumentProfile
  actions: PrescriptionPriorityAction[]
  prescription: ReviewPrescription
}) {
  const actionsPayload = params.actions.map((action) => ({
    priority: action.priority,
    problem: action.action_summary,
    why: action.why,
    nature: action.nature ?? null,
    position_relation: action.position_relation ?? null,
    grouping_logic: action.grouping_logic ?? null,
  }))
  return `<document_profile>
${JSON.stringify(params.documentProfile, null, 2)}
</document_profile>

<confirmed_problems>
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
    return normalizeFixPlans(parsed.fix_plans, params.targetSp, validPriorities)
  } catch {
    // 修复方案生成失败不阻塞报告：返回空，UI 显示"本次未生成修复建议"
    return []
  }
}
