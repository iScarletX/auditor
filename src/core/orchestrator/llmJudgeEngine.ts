import { BUTLER_CRITIC_SYSTEM_PROMPT } from '../../prompts/butlerCriticSystemPrompt'
import type {
  EvidenceType,
  Fix,
  FixAction,
  Issue,
  IssueCategory,
  IssueSeverity,
  IssueStatus,
  ModelConfig,
  ScenarioAssumption,
  SkillDefinition,
} from '../../types/reviewReport.types'
import { getProviderAdapter } from '../modelProvider/providerAdapter'
import { parseJsonObject } from '../responseRepair/autoRepairJson'
import { retryWithErrorFeedback } from '../responseRepair/retryWithErrorFeedback'
import type { StaticCheckResult } from './staticCheckEngine'

const CATEGORIES: IssueCategory[] = [
  'clarity',
  'contract',
  'resource',
  'interop',
  'robustness',
  'quality',
  'compliance',
]

const SEVERITIES: IssueSeverity[] = ['critical', 'major', 'minor', 'info']
const STATUSES: IssueStatus[] = ['found', 'not_applicable']
const EVIDENCE_TYPES: EvidenceType[] = [
  'explicit_conflict',
  'explicit_omission',
  'semantic_inference',
  'stylistic_judgment',
]
const SCENARIO_ASSUMPTIONS: ScenarioAssumption[] = [
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

interface UnknownIssue {
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
}

interface UnknownReport {
  issues?: unknown
}

export interface ModelJudgeOutput {
  modelId: string
  issues: Issue[]
  error?: string
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

function normalizeLineRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const start = Number(value[0])
  const end = Number(value[1])
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return [Math.max(1, Math.round(start)), Math.max(1, Math.round(end))]
}

function normalizeIssue(
  value: UnknownIssue,
  skill: SkillDefinition,
  modelId: string,
  index: number,
  scenarioHint: string,
): Issue {
  const category = CATEGORIES.includes(value.category as IssueCategory)
    ? (value.category as IssueCategory)
    : skill.category
  const status = STATUSES.includes(value.status as IssueStatus)
    ? (value.status as IssueStatus)
    : 'found'
  const location = value.location ?? {}
  const base = {
    id: typeof value.id === 'string' && value.id ? value.id : `${skill.id}-${index + 1}`,
    skill_id: typeof value.skill_id === 'string' && value.skill_id ? value.skill_id : skill.id,
    category,
    status,
    execution_mode: skill.execution_mode,
    domain_specific: skill.domain_specific,
    consensus: 'single_model_flag' as const,
    vote: {
      models_flagged: status === 'found' ? [modelId] : [],
      models_passed: status === 'found' ? [] : [modelId],
    },
    location: {
      anchor_before: typeof location.anchor_before === 'string' ? location.anchor_before : '',
      anchor_after: typeof location.anchor_after === 'string' ? location.anchor_after : '',
      matched_text: typeof location.matched_text === 'string' ? location.matched_text : undefined,
      line_range: normalizeLineRange(location.line_range),
      ambiguous: Boolean(location.ambiguous),
    },
    description: typeof value.description === 'string' && value.description
      ? value.description
      : status === 'found'
        ? '模型标记了该检查项，但未返回完整描述。'
        : '该检查项不适用于当前 System Prompt。',
    fix: status === 'found' ? normalizeFix(value.fix) : null,
  }

  if (status === 'not_applicable') {
    return {
      ...base,
      not_applicable_reason: typeof value.not_applicable_reason === 'string' && value.not_applicable_reason
        ? value.not_applicable_reason
        : '当前 target_sp 不涉及该检查项。',
    }
  }

  return {
    ...base,
    severity: SEVERITIES.includes(value.severity as IssueSeverity)
      ? (value.severity as IssueSeverity)
      : 'major',
    evidence_type: EVIDENCE_TYPES.includes(value.evidence_type as EvidenceType)
      ? (value.evidence_type as EvidenceType)
      : 'semantic_inference',
    scenario_assumption: SCENARIO_ASSUMPTIONS.includes(value.scenario_assumption as ScenarioAssumption)
      ? (value.scenario_assumption as ScenarioAssumption)
      : scenarioHint.trim()
        ? 'user_provided'
        : 'inferred_from_text',
  }
}

function buildUserPrompt(
  skill: SkillDefinition,
  staticResult: StaticCheckResult | null,
  targetSp: string,
  scenarioHint: string,
) {
  return `<loaded_skills>
${skill.fullContent}
</loaded_skills>

<static_check_results>
${JSON.stringify(staticResult ?? { skill_id: skill.id, issues: [] }, null, 2)}
</static_check_results>

<scenario_hint>
${scenarioHint}
</scenario_hint>

<target_sp>
${targetSp}
</target_sp>`
}

export async function judgeSkillWithModels(params: {
  skill: SkillDefinition
  targetSp: string
  scenarioHint: string
  staticResult: StaticCheckResult | null
  models: ModelConfig[]
  apiKey: string
  signal?: AbortSignal
}): Promise<ModelJudgeOutput[]> {
  const tasks = params.models.map(async (model): Promise<ModelJudgeOutput> => {
    try {
      const adapter = getProviderAdapter(model.provider)
      const request = {
        baseUrl: model.baseUrl,
        apiKey: params.apiKey,
        modelId: model.modelId,
        signal: params.signal,
        messages: [
          { role: 'system' as const, content: BUTLER_CRITIC_SYSTEM_PROMPT },
          {
            role: 'user' as const,
            content: buildUserPrompt(params.skill, params.staticResult, params.targetSp, params.scenarioHint),
          },
        ],
      }
      const content = await retryWithErrorFeedback({
        adapter,
        request,
        schemaName: 'SkillIssueList',
        validate: (raw) => {
          const parsed = parseJsonObject<UnknownReport>(raw)
          if (!Array.isArray(parsed.issues)) throw new Error('缺少 issues 数组')
        },
      })
      const parsed = parseJsonObject<UnknownReport>(content)
      const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : []
      return {
        modelId: model.modelId,
        issues: rawIssues.map((issue, index) =>
          normalizeIssue(issue as UnknownIssue, params.skill, model.modelId, index, params.scenarioHint),
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
