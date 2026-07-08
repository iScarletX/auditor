import { BUTLER_CRITIC_SYSTEM_PROMPT } from '../../prompts/butlerCriticSystemPrompt'
import type {
  DocumentProfile,
  Issue,
  ModelConfig,
  RawModelOutput,
  SkillDefinition,
} from '../../types/reviewReport.types'
import { getProviderAdapter } from '../modelProvider/providerAdapter'
import { parseJsonObject } from '../responseRepair/autoRepairJson'
import {
  retryWithErrorFeedback,
  RetryWithFeedbackError,
  type RetryRawResponse,
} from '../responseRepair/retryWithErrorFeedback'
import { formatDocumentProfileForPrompt } from './documentProfiler'
import { normalizeStrictIssue, type RawIssueCandidate } from './issueValidation'
import { buildPackageManifest } from './packageManifest'
import type { StaticCheckResult } from './staticCheckEngine'

interface UnknownReport {
  issues?: unknown
}

export interface ModelJudgeOutput {
  modelId: string
  issues: Issue[]
  raw_model_outputs: RawModelOutput[]
  error?: string
}

function buildRawModelOutputs(params: {
  reviewId: string
  skill: SkillDefinition
  modelId: string
  schemaName: string
  rawResponses: RetryRawResponse[]
}): RawModelOutput[] {
  return params.rawResponses.map((response) => ({
    id: crypto.randomUUID(),
    review_id: params.reviewId,
    phase: 'skill_check',
    skill_id: params.skill.id,
    skill_title: params.skill.title,
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
  skill: SkillDefinition,
  modelId: string,
  index: number,
  rawModelOutputIds: string[],
  targetSp: string,
): Issue | null {
  return normalizeStrictIssue({
    value,
    fallbackId: `${skill.id}-${index + 1}`,
    expectedSkillId: skill.id,
    modelId,
    executionMode: skill.execution_mode,
    domainSpecific: skill.domain_specific,
    consensus: 'single_model_flag',
    flaggedModelIds: value.status === 'found' ? [modelId] : [],
    passedModelIds: value.status === 'found' ? [] : [modelId],
    rawModelOutputIds,
    fixRequiresReview: true,
    targetSp,
  })
}

function buildUserPrompt(
  skill: SkillDefinition,
  documentProfile: DocumentProfile,
  staticResult: StaticCheckResult | null,
  targetSp: string,
  scenarioHint: string,
) {
  const manifest = buildPackageManifest(targetSp)
  return `<loaded_skills>
${skill.fullContent}
</loaded_skills>

${formatDocumentProfileForPrompt(documentProfile)}

${manifest ? `<package_manifest>\n${manifest}\n</package_manifest>\n\n` : ''}<static_check_results>
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
  documentProfile: DocumentProfile
  staticResult: StaticCheckResult | null
  models: ModelConfig[]
  apiKey: string
  reviewId: string
  signal?: AbortSignal
}): Promise<ModelJudgeOutput[]> {
  const tasks = params.models.map((model) =>
    judgeSkillWithModel({
      skill: params.skill,
      targetSp: params.targetSp,
      scenarioHint: params.scenarioHint,
      documentProfile: params.documentProfile,
      staticResult: params.staticResult,
      model,
      apiKey: params.apiKey,
      reviewId: params.reviewId,
      signal: params.signal,
    }),
  )

  return Promise.all(tasks)
}

export async function judgeSkillWithModel(params: {
  skill: SkillDefinition
  targetSp: string
  scenarioHint: string
  documentProfile: DocumentProfile
  staticResult: StaticCheckResult | null
  model: ModelConfig
  apiKey: string
  reviewId: string
  signal?: AbortSignal
}): Promise<ModelJudgeOutput> {
  const schemaName = 'SkillIssueList'
  try {
    const adapter = getProviderAdapter(params.model.provider)
    const request = {
      baseUrl: params.model.baseUrl,
      apiKey: params.apiKey,
      modelId: params.model.modelId,
      signal: params.signal,
      messages: [
        { role: 'system' as const, content: BUTLER_CRITIC_SYSTEM_PROMPT },
        {
          role: 'user' as const,
          content: buildUserPrompt(
            params.skill,
            params.documentProfile,
            params.staticResult,
            params.targetSp,
            params.scenarioHint,
          ),
        },
      ],
    }
    const result = await retryWithErrorFeedback({
      adapter,
      request,
      schemaName,
      validate: (raw) => {
        const parsed = parseJsonObject<UnknownReport>(raw)
        if (!Array.isArray(parsed.issues)) throw new Error('缺少 issues 数组')
      },
    })
    const rawModelOutputs = buildRawModelOutputs({
      reviewId: params.reviewId,
      skill: params.skill,
      modelId: params.model.modelId,
      schemaName,
      rawResponses: result.rawResponses,
    })
    const rawModelOutputIds = rawModelOutputs.map((output) => output.id)
    const content = result.content
    const parsed = parseJsonObject<UnknownReport>(content)
    const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : []
    const issuesToNormalize = rawIssues.length > 0
      ? rawIssues
      : [{
          id: `${params.skill.id}_not_applicable`,
          skill_id: params.skill.id,
          category: params.skill.category,
          status: 'not_applicable',
          scenario_assumption: params.scenarioHint.trim() ? 'user_provided' : 'inferred_from_text',
          not_applicable_reason: '模型返回空 issues；系统将空结论规范化为 not_applicable，避免静默跳过检查项。',
          location: {
            anchor_before: '',
            anchor_after: '',
            matched_text: '',
            ambiguous: true,
          },
          description: '模型没有返回 found 结论；系统将空结论规范化为 not_applicable。',
          fix: null,
        }]
    return {
      modelId: params.model.modelId,
      raw_model_outputs: rawModelOutputs,
      issues: issuesToNormalize.map((issue, index) =>
        normalizeIssue(
          issue as RawIssueCandidate,
          params.skill,
          params.model.modelId,
          index,
          rawModelOutputIds,
          params.targetSp,
        ),
      ).filter((issue): issue is Issue => Boolean(issue)),
    }
  } catch (error) {
    const rawModelOutputs = error instanceof RetryWithFeedbackError
      ? buildRawModelOutputs({
          reviewId: params.reviewId,
          skill: params.skill,
          modelId: params.model.modelId,
          schemaName,
          rawResponses: error.rawResponses,
        })
      : []
    return {
      modelId: params.model.modelId,
      issues: [],
      raw_model_outputs: rawModelOutputs,
      error: error instanceof Error ? error.message : '模型判断失败',
    }
  }
}
