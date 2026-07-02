import { BUTLER_CRITIC_SYSTEM_PROMPT } from '../../prompts/butlerCriticSystemPrompt'
import type {
  Fix,
  FixAction,
  Issue,
  IssueCategory,
  IssueSeverity,
  ModelConfig,
  SkillDefinition,
} from '../../types/reviewReport.types'
import { clamp } from '../../lib/utils'
import { getProviderAdapter } from '../modelProvider/providerAdapter'
import type { StaticCheckResult } from './staticCheckEngine'

const CATEGORIES: IssueCategory[] = [
  'engineering_contract',
  'instruction_quality',
  'structure',
  'io_contract',
  'robustness',
  'quality_control',
]

const SEVERITIES: IssueSeverity[] = ['critical', 'major', 'minor', 'info']

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

interface UnknownIssue {
  id?: unknown
  skill_id?: unknown
  category?: unknown
  severity?: unknown
  confidence?: unknown
  location?: {
    anchor_before?: unknown
    anchor_after?: unknown
    matched_text?: unknown
    line_range?: unknown
    ambiguous?: unknown
  }
  description?: unknown
  fix?: unknown
}

interface UnknownReport {
  issues?: unknown
}

export interface ModelJudgeOutput {
  modelId: string
  issues: Issue[]
  error?: string
}

function stripCodeFence(content: string) {
  return content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
}

function parseJsonObject(content: string): UnknownReport {
  const cleaned = stripCodeFence(content)
  try {
    return JSON.parse(cleaned) as UnknownReport
  } catch {
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first === -1 || last === -1 || last <= first) throw new Error('模型输出不是可解析 JSON')
    return JSON.parse(cleaned.slice(first, last + 1)) as UnknownReport
  }
}

function normalizeFix(value: unknown): Fix | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<Fix>
  if (!candidate.action || !FIX_ACTIONS.includes(candidate.action)) return null

  return {
    action: candidate.action,
    target: typeof candidate.target === 'string' ? candidate.target : undefined,
    from: candidate.from,
    to: candidate.to,
    content: typeof candidate.content === 'string' ? candidate.content : undefined,
    fix_requires_review: true,
  }
}

function normalizeIssue(
  value: UnknownIssue,
  skill: SkillDefinition,
  modelId: string,
  index: number,
): Issue {
  const category = CATEGORIES.includes(value.category as IssueCategory)
    ? (value.category as IssueCategory)
    : skill.category
  const severity = SEVERITIES.includes(value.severity as IssueSeverity)
    ? (value.severity as IssueSeverity)
    : 'major'
  const rawConfidence = typeof value.confidence === 'number' ? value.confidence : 0.5
  const location = value.location ?? {}

  return {
    id: typeof value.id === 'string' && value.id ? value.id : `${skill.id}-${index + 1}`,
    skill_id: typeof value.skill_id === 'string' && value.skill_id ? value.skill_id : skill.id,
    category,
    severity,
    confidence: clamp(rawConfidence, 0, 1),
    execution_mode: skill.execution_mode,
    domain_specific: skill.domain_specific,
    consensus: 'single_model_flag',
    vote: {
      models_flagged: [modelId],
      models_passed: [],
    },
    location: {
      anchor_before: typeof location.anchor_before === 'string' ? location.anchor_before : '',
      anchor_after: typeof location.anchor_after === 'string' ? location.anchor_after : '',
      matched_text: typeof location.matched_text === 'string' ? location.matched_text : undefined,
      line_range: Array.isArray(location.line_range) && location.line_range.length === 2
        ? [Number(location.line_range[0]), Number(location.line_range[1])]
        : undefined,
      ambiguous: Boolean(location.ambiguous),
    },
    description: typeof value.description === 'string' && value.description
      ? value.description
      : '模型标记了该检查项，但未返回完整描述。',
    fix: normalizeFix(value.fix),
  }
}

function buildUserPrompt(skill: SkillDefinition, staticResult: StaticCheckResult | null, targetSp: string) {
  return `<loaded_skills>
${skill.fullContent}
</loaded_skills>

<static_check_results>
${JSON.stringify(staticResult ?? { skill_id: skill.id, issues: [] }, null, 2)}
</static_check_results>

<target_sp>
${targetSp}
</target_sp>`
}

export async function judgeSkillWithModels(params: {
  skill: SkillDefinition
  targetSp: string
  staticResult: StaticCheckResult | null
  models: ModelConfig[]
  apiKey: string
  signal?: AbortSignal
}): Promise<ModelJudgeOutput[]> {
  const tasks = params.models.map(async (model): Promise<ModelJudgeOutput> => {
    try {
      const adapter = getProviderAdapter(model.provider)
      const content = await adapter.chatCompletion({
        baseUrl: model.baseUrl,
        apiKey: params.apiKey,
        modelId: model.modelId,
        signal: params.signal,
        messages: [
          { role: 'system', content: BUTLER_CRITIC_SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(params.skill, params.staticResult, params.targetSp) },
        ],
      })
      const parsed = parseJsonObject(content)
      const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : []
      return {
        modelId: model.modelId,
        issues: rawIssues.map((issue, index) =>
          normalizeIssue(issue as UnknownIssue, params.skill, model.modelId, index),
        ),
      }
    } catch (error) {
      return {
        modelId: model.modelId,
        issues: [],
        error: error instanceof Error ? error.message : '模型判断失败',
      }
    }
  })

  return Promise.all(tasks)
}
