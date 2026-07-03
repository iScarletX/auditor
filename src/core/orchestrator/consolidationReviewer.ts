import { BUTLER_CONSOLIDATION_SYSTEM_PROMPT } from '../../prompts/butlerCriticSystemPrompt'
import type {
  EvidenceType,
  Fix,
  FixAction,
  Issue,
  IssueCategory,
  IssueSeverity,
  ModelConfig,
  ReviewConsolidation,
  ScenarioAssumption,
} from '../../types/reviewReport.types'
import { getProviderAdapter } from '../modelProvider/providerAdapter'
import { parseJsonObject } from '../responseRepair/autoRepairJson'
import { retryWithErrorFeedback } from '../responseRepair/retryWithErrorFeedback'

const EMPTY_CONSOLIDATION: ReviewConsolidation = {
  has_new_findings: false,
  new_issues: [],
  conflict_notes: [],
  systemic_findings: [],
}

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

interface UnknownConsolidation {
  has_new_findings?: unknown
  new_issues?: unknown
  conflict_notes?: unknown
  systemic_findings?: unknown
}

interface UnknownIssue {
  id?: unknown
  skill_id?: unknown
  category?: unknown
  status?: unknown
  severity?: unknown
  evidence_type?: unknown
  scenario_assumption?: unknown
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

function normalizeNewIssue(value: UnknownIssue, index: number, scenarioHint: string): Issue {
  const category = CATEGORIES.includes(value.category as IssueCategory)
    ? (value.category as IssueCategory)
    : 'clarity'
  const location = value.location ?? {}
  return {
    id: typeof value.id === 'string' && value.id ? `consolidation-${value.id}` : `consolidation-${index + 1}`,
    skill_id: typeof value.skill_id === 'string' && value.skill_id ? value.skill_id : 'consolidation_reviewer',
    category,
    status: 'found',
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
    execution_mode: 'llm_judge',
    domain_specific: false,
    consensus: 'single_model_flag',
    vote: {
      models_flagged: ['consolidation_reviewer'],
      models_passed: [],
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
      : '汇总复核发现一个疑似漏检问题。',
    fix: normalizeFix(value.fix),
  }
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeConsolidation(parsed: UnknownConsolidation, scenarioHint: string): ReviewConsolidation {
  const newIssues = Array.isArray(parsed.new_issues)
    ? parsed.new_issues.map((issue, index) => normalizeNewIssue(issue as UnknownIssue, index, scenarioHint))
    : []
  const conflictNotes = Array.isArray(parsed.conflict_notes)
    ? parsed.conflict_notes
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const candidate = item as Record<string, unknown>
          return {
            issue_ids: normalizeStringArray(candidate.issue_ids),
            description: typeof candidate.description === 'string' ? candidate.description : '',
            recommendation: typeof candidate.recommendation === 'string' ? candidate.recommendation : '',
          }
        })
        .filter((item) => item.description && item.recommendation)
    : []
  const systemicFindings = Array.isArray(parsed.systemic_findings)
    ? parsed.systemic_findings
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const candidate = item as Record<string, unknown>
          return {
            related_issue_ids: normalizeStringArray(candidate.related_issue_ids),
            description: typeof candidate.description === 'string' ? candidate.description : '',
            severity: SEVERITIES.includes(candidate.severity as IssueSeverity)
              ? (candidate.severity as IssueSeverity)
              : 'major',
          }
        })
        .filter((item) => item.description)
    : []

  return {
    has_new_findings: Boolean(parsed.has_new_findings) && newIssues.length > 0,
    new_issues: newIssues,
    conflict_notes: conflictNotes,
    systemic_findings: systemicFindings,
  }
}

function buildPrompt(params: {
  targetSp: string
  scenarioHint: string
  issues: Issue[]
}) {
  return `<scenario_hint>
${params.scenarioHint}
</scenario_hint>

<target_sp>
${params.targetSp}
</target_sp>

<preliminary_issues>
${JSON.stringify(params.issues, null, 2)}
</preliminary_issues>`
}

export async function runConsolidationReview(params: {
  targetSp: string
  scenarioHint: string
  issues: Issue[]
  model: ModelConfig | null
  apiKey: string | null
  signal?: AbortSignal
}): Promise<ReviewConsolidation> {
  if (!params.model || !params.apiKey) return EMPTY_CONSOLIDATION

  try {
    const adapter = getProviderAdapter(params.model.provider)
    const request = {
      baseUrl: params.model.baseUrl,
      apiKey: params.apiKey,
      modelId: params.model.modelId,
      signal: params.signal,
      messages: [
        { role: 'system' as const, content: BUTLER_CONSOLIDATION_SYSTEM_PROMPT },
        { role: 'user' as const, content: buildPrompt(params) },
      ],
    }
    const content = await retryWithErrorFeedback({
      adapter,
      request,
      schemaName: 'ReviewConsolidation',
      validate: (raw) => {
        const parsed = parseJsonObject<UnknownConsolidation>(raw)
        if (!Array.isArray(parsed.new_issues)) throw new Error('缺少 new_issues 数组')
      },
    })
    return normalizeConsolidation(parseJsonObject<UnknownConsolidation>(content), params.scenarioHint)
  } catch {
    return EMPTY_CONSOLIDATION
  }
}
