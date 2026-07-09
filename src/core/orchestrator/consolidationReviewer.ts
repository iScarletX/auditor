import {
  BUTLER_CONSOLIDATION_B1_SYSTEM_PROMPT,
  BUTLER_CONSOLIDATION_B2_SYSTEM_PROMPT,
} from '../../prompts/butlerCriticSystemPrompt'
import type {
  CandidateIssueGroup,
  ConsolidationConflictNote,
  ConsolidationSynthesisResult,
  DocumentProfile,
  Issue,
  IssueGroup,
  ModelConfig,
  RawModelOutput,
  RawModelOutputPhase,
  PrescriptionPriorityAction,
  ReviewConsolidationResult,
  ReviewPrescription,
} from '../../types/reviewReport.types'
import { getProviderAdapter } from '../modelProvider/providerAdapter'
import { parseJsonObject } from '../responseRepair/autoRepairJson'
import { retryWithErrorFeedback, type RetryRawResponse } from '../responseRepair/retryWithErrorFeedback'
import { formatDocumentProfileForPrompt } from './documentProfiler'
import { issueGroupLooksSimilar } from './issueSimilarity'
import { normalizeStrictIssue, type RawIssueCandidate } from './issueValidation'
import { buildPackageManifest } from './packageManifest'
import { buildStructuralChecklistPrompt } from './structuralChecklist'

function emptyPrescription(overallAssessment = '复核完毕，未生成额外综合处方。'): ReviewPrescription {
  return {
    overall_assessment: overallAssessment,
    priority_actions: [],
    minor_notes: [],
    revised_document_available: false,
    revised_document_diff_summary: '未生成完整改后版本。',
  }
}

const EMPTY_RESULT: ReviewConsolidationResult = {
  new_issues: [],
  conflict_notes: [],
  synthesis_results: [],
  prescription: emptyPrescription('最终把关未执行或未产生综合处方。'),
  summary_note: '复核完毕，无新增问题。',
}

interface UnknownIssueList {
  issues?: unknown
}

interface UnknownB2Result {
  new_issues?: unknown
  conflict_notes?: unknown
  synthesis_results?: unknown
  summary_note?: unknown
  prescription?: unknown
}

function buildConsolidationRawOutputs(params: {
  reviewId: string
  phase: RawModelOutputPhase
  modelId: string
  schemaName: string
  rawResponses: RetryRawResponse[]
}): RawModelOutput[] {
  return params.rawResponses.map((response) => ({
    id: crypto.randomUUID(),
    review_id: params.reviewId,
    phase: params.phase,
    model_id: params.modelId,
    attempt: response.attempt,
    schema_name: params.schemaName,
    created_at: new Date().toISOString(),
    raw_response_text: response.rawResponseText,
    extracted_content: response.extractedContent,
  }))
}

function normalizeIssue(
  value: RawIssueCandidate,
  index: number,
  modelId: string,
  rawModelOutputIds: string[] = [],
  targetSp?: string,
): Issue | null {
  return normalizeStrictIssue({
    value,
    fallbackId: `consolidation-${index + 1}`,
    modelId,
    executionMode: 'llm_judge',
    domainSpecific: false,
    consensus: 'single_model_flag',
    flaggedModelIds: value.status === 'found' ? [modelId] : [],
    passedModelIds: value.status === 'found' ? [] : [modelId],
    rawModelOutputIds,
    fixRequiresReview: true,
    targetSp,
  })
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizePriorityActions(value: unknown): PrescriptionPriorityAction[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const candidate = item as Record<string, unknown>
      const priority = Number(candidate.priority)
      const nature = ['wording', 'flow', 'engineering', 'safety'].includes(candidate.nature as string)
        ? (candidate.nature as 'wording' | 'flow' | 'engineering' | 'safety')
        : undefined
      const positionRelation = ['joint', 'independent'].includes(candidate.position_relation as string)
        ? (candidate.position_relation as 'joint' | 'independent')
        : undefined
      return {
        priority: Number.isFinite(priority) && priority >= 1 ? Math.round(priority) : index + 1,
        action_summary: normalizeString(candidate.action_summary),
        why: normalizeString(candidate.why),
        related_issue_ids: normalizeStringArray(candidate.related_issue_ids),
        conflicts_resolved: normalizeString(candidate.conflicts_resolved),
        ...(nature ? { nature } : {}),
        ...(normalizeString(candidate.grouping_logic) ? { grouping_logic: normalizeString(candidate.grouping_logic) } : {}),
        ...(positionRelation ? { position_relation: positionRelation } : {}),
      }
    })
    .filter((item) => item.action_summary && item.why)
    .sort((a, b) => a.priority - b.priority)
}

function normalizePrescription(value: unknown): ReviewPrescription {
  if (!value || typeof value !== 'object') {
    return emptyPrescription('B2未返回有效综合处方。')
  }

  const candidate = value as Record<string, unknown>
  const revisedDocumentAfter = normalizeString(candidate.revised_document_after) || undefined
  const requestedRevisedDocument = candidate.revised_document_available === true
  const revisedDocumentAvailable = Boolean(requestedRevisedDocument && revisedDocumentAfter)
  const diffSummary = normalizeString(
    candidate.revised_document_diff_summary,
    revisedDocumentAvailable
      ? 'B2生成了完整改后版本，需用户查看完整diff后确认。'
      : '本次不适合自动生成完整改后版本。',
  )

  return {
    overall_assessment: normalizeString(candidate.overall_assessment, 'B2未返回整体诊断结论。'),
    priority_actions: normalizePriorityActions(candidate.priority_actions),
    minor_notes: normalizeStringArray(candidate.minor_notes),
    revised_document_available: revisedDocumentAvailable,
    revised_document_diff_summary: requestedRevisedDocument && !revisedDocumentAvailable
      ? `${diffSummary} B2声明可生成改后版本，但没有返回完整revised_document_after，系统已降级为不可用。`
      : diffSummary,
    ...(revisedDocumentAvailable ? { revised_document_after: revisedDocumentAfter } : {}),
  }
}

function isNovelAgainstExisting(issue: Issue, issueGroups: IssueGroup[]) {
  return !issueGroups.some((group) => issueGroupLooksSimilar(issue, group))
}

function isFoundIssue(issue: Issue | null): issue is Issue {
  return Boolean(issue) && issue?.status === 'found'
}

function normalizeB1(
  raw: string,
  modelId: string,
  rawModelOutputIds: string[],
  issueGroups: IssueGroup[],
  targetSp: string,
): Issue[] {
  const parsed = parseJsonObject<UnknownIssueList>(raw)
  const issues = Array.isArray(parsed.issues) ? parsed.issues : []
  return issues
    .map((issue, index) => normalizeIssue(issue as RawIssueCandidate, index, modelId, rawModelOutputIds, targetSp))
    .filter(isFoundIssue)
    .filter((issue) => isNovelAgainstExisting(issue, issueGroups))
}

function normalizeB2(
  parsed: UnknownB2Result,
  modelId: string,
  rawModelOutputIds: string[],
  issueGroups: IssueGroup[],
  targetSp?: string,
): ReviewConsolidationResult {
  const newIssues = Array.isArray(parsed.new_issues)
    ? parsed.new_issues.map((issue, index) =>
        normalizeIssue(issue as RawIssueCandidate, index, modelId, rawModelOutputIds, targetSp),
      ).filter(isFoundIssue)
      .filter((issue) => isNovelAgainstExisting(issue, issueGroups))
    : []
  const conflictNotes: ConsolidationConflictNote[] = Array.isArray(parsed.conflict_notes)
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
  const synthesisResults: ConsolidationSynthesisResult[] = Array.isArray(parsed.synthesis_results)
    ? parsed.synthesis_results
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const candidate = item as Record<string, unknown>
          return {
            candidate_group_id: typeof candidate.candidate_group_id === 'string' ? candidate.candidate_group_id : '',
            has_common_root_cause: Boolean(candidate.has_common_root_cause),
            reason: typeof candidate.reason === 'string' ? candidate.reason : undefined,
            synthesized_title: typeof candidate.synthesized_title === 'string' ? candidate.synthesized_title : undefined,
            member_issue_ids: normalizeStringArray(candidate.member_issue_ids),
          }
        })
        .filter((item) => item.candidate_group_id)
    : []

  const hasMaterialChange =
    newIssues.length > 0 ||
    conflictNotes.length > 0 ||
    synthesisResults.some((item) => item.has_common_root_cause)

  return {
    new_issues: newIssues,
    conflict_notes: conflictNotes,
    synthesis_results: synthesisResults,
    prescription: normalizePrescription(parsed.prescription),
    summary_note: typeof parsed.summary_note === 'string' && parsed.summary_note
      ? parsed.summary_note
      : hasMaterialChange
        ? '复核完毕，发现需要合并或补充的问题。'
        : '复核完毕，无新增问题。',
  }
}

export function buildConsolidationB1Prompt(targetSp: string, documentProfile?: DocumentProfile) {
  const profileBlock = documentProfile ? `${formatDocumentProfileForPrompt(documentProfile)}\n\n` : ''
  const manifest = buildPackageManifest(targetSp)
  const manifestBlock = manifest ? `<package_manifest>\n${manifest}\n</package_manifest>\n\n` : ''
  const checklist = buildStructuralChecklistPrompt(documentProfile?.structural_patterns)
  const checklistBlock = checklist ? `<structural_checklist>\n${checklist}\n</structural_checklist>\n\n` : ''
  return `${profileBlock}${manifestBlock}${checklistBlock}<target_sp>
${targetSp}
</target_sp>`
}

function buildB2Prompt(params: {
  targetSp: string
  documentProfile: DocumentProfile
  independentIssues: Issue[]
  issueGroups: IssueGroup[]
  candidateGroups: CandidateIssueGroup[]
}) {
  const manifest = buildPackageManifest(params.targetSp)
  const manifestBlock = manifest ? `<package_manifest>\n${manifest}\n</package_manifest>\n\n` : ''
  const checklist = buildStructuralChecklistPrompt(params.documentProfile.structural_patterns)
  const checklistBlock = checklist ? `<structural_checklist>\n${checklist}\n</structural_checklist>\n\n` : ''
  return `${formatDocumentProfileForPrompt(params.documentProfile)}

${manifestBlock}${checklistBlock}<target_sp>
${params.targetSp}
</target_sp>

<independent_b1_issues>
${JSON.stringify(params.independentIssues, null, 2)}
</independent_b1_issues>

<confirmed_issue_groups>
${JSON.stringify(params.issueGroups, null, 2)}
</confirmed_issue_groups>

<candidate_groups>
${JSON.stringify(params.candidateGroups, null, 2)}
</candidate_groups>`
}

export async function runConsolidationReview(params: {
  targetSp: string
  scenarioHint: string
  documentProfile: DocumentProfile
  issueGroups: IssueGroup[]
  candidateGroups: CandidateIssueGroup[]
  model: ModelConfig | null
  apiKey: string | null
  reviewId: string
  onRawModelOutputs?: (outputs: RawModelOutput[]) => void
  signal?: AbortSignal
}): Promise<ReviewConsolidationResult> {
  if (!params.model || !params.apiKey) return EMPTY_RESULT

  try {
    const adapter = getProviderAdapter(params.model.provider)
    const b1SchemaName = 'IndependentIssueList'
    const b1Result = await retryWithErrorFeedback({
      adapter,
      request: {
        baseUrl: params.model.baseUrl,
        apiKey: params.apiKey,
        modelId: params.model.modelId,
        signal: params.signal,
        messages: [
          { role: 'system', content: BUTLER_CONSOLIDATION_B1_SYSTEM_PROMPT },
          { role: 'user', content: buildConsolidationB1Prompt(params.targetSp, params.documentProfile) },
        ],
      },
      schemaName: b1SchemaName,
      validate: (raw) => {
        const parsed = parseJsonObject<UnknownIssueList>(raw)
        if (!Array.isArray(parsed.issues)) throw new Error('缺少 issues 数组')
      },
    })
    const b1RawOutputs = buildConsolidationRawOutputs({
      reviewId: params.reviewId,
      phase: 'consolidation_b1',
      modelId: params.model.modelId,
      schemaName: b1SchemaName,
      rawResponses: b1Result.rawResponses,
    })
    params.onRawModelOutputs?.(b1RawOutputs)
    const independentIssues = normalizeB1(
      b1Result.content,
      params.model.modelId,
      b1RawOutputs.map((output) => output.id),
      params.issueGroups,
      params.targetSp,
    )

    const b2SchemaName = 'ConsolidationB2Result'
    const b2Result = await retryWithErrorFeedback({
      adapter,
      request: {
        baseUrl: params.model.baseUrl,
        apiKey: params.apiKey,
        modelId: params.model.modelId,
        signal: params.signal,
        messages: [
          { role: 'system', content: BUTLER_CONSOLIDATION_B2_SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildB2Prompt({
              targetSp: params.targetSp,
              documentProfile: params.documentProfile,
              independentIssues,
              issueGroups: params.issueGroups,
              candidateGroups: params.candidateGroups,
            }),
          },
        ],
      },
      schemaName: b2SchemaName,
      validate: (raw) => {
        const parsed = parseJsonObject<UnknownB2Result>(raw)
        if (!Array.isArray(parsed.new_issues)) throw new Error('缺少 new_issues 数组')
        if (!Array.isArray(parsed.conflict_notes)) throw new Error('缺少 conflict_notes 数组')
        if (!Array.isArray(parsed.synthesis_results)) throw new Error('缺少 synthesis_results 数组')
        if (!parsed.prescription || typeof parsed.prescription !== 'object') throw new Error('缺少 prescription 对象')
      },
    })
    const b2RawOutputs = buildConsolidationRawOutputs({
      reviewId: params.reviewId,
      phase: 'consolidation_b2',
      modelId: params.model.modelId,
      schemaName: b2SchemaName,
      rawResponses: b2Result.rawResponses,
    })
    params.onRawModelOutputs?.(b2RawOutputs)

    return normalizeB2(
      parseJsonObject<UnknownB2Result>(b2Result.content),
      params.model.modelId,
      b2RawOutputs.map((output) => output.id),
      params.issueGroups,
      params.targetSp,
    )
  } catch {
    return EMPTY_RESULT
  }
}
