import Ajv from 'ajv'
import documentProfileSchema from '../../schemas/documentProfile.schema.json'
import { BUTLER_DOCUMENT_PROFILE_SYSTEM_PROMPT } from '../../prompts/butlerCriticSystemPrompt'
import type {
  DocumentProfile,
  ModelConfig,
  RawModelOutput,
} from '../../types/reviewReport.types'
import { getProviderAdapter } from '../modelProvider/providerAdapter'
import { buildPackageManifest } from './packageManifest'
import { parseJsonObject } from '../responseRepair/autoRepairJson'
import {
  retryWithErrorFeedback,
  type RetryRawResponse,
} from '../responseRepair/retryWithErrorFeedback'

const ajv = new Ajv({ strict: false, validateFormats: false })
const validateDocumentProfile = ajv.compile<DocumentProfile>(documentProfileSchema)

export const DOCUMENT_PROFILE_SCHEMA_NAME = 'DocumentProfile'

export function buildDocumentProfilePrompt(targetSp: string) {
  const manifest = buildPackageManifest(targetSp)
  return `${manifest ? `<package_manifest>\n${manifest}\n</package_manifest>\n\n` : ''}<target_sp>
${targetSp}
</target_sp>`
}

export function formatDocumentProfileForPrompt(documentProfile: DocumentProfile) {
  return `<document_profile>
${JSON.stringify(documentProfile, null, 2)}
</document_profile>

<document_profile_usage_rules>
- Treat document_profile as mandatory background before judging each check_item.
- Use it to decide whether the current check_item applies to this target_sp's purpose, output consumer, declared exclusions, conventions, and interaction mode.
- Do not let the profile suppress concrete evidence in target_sp. If a found issue contradicts document_profile, keep the issue, set profile_conflict=true, fill profile_conflict_detail, and include "画像矛盾：" in description, stating both the profile claim and the target_sp evidence that conflicts with it.
- Do not report issues whose fix would require changing runtime configuration outside the prompt text, such as model choice, max_tokens, or temperature; return not_applicable for those with the configured boundary reason.
</document_profile_usage_rules>`
}

function buildRawModelOutputs(params: {
  reviewId: string
  modelId: string
  rawResponses: RetryRawResponse[]
}): RawModelOutput[] {
  return params.rawResponses.map((response) => ({
    id: crypto.randomUUID(),
    review_id: params.reviewId,
    phase: 'document_profile',
    model_id: params.modelId,
    attempt: response.attempt,
    schema_name: DOCUMENT_PROFILE_SCHEMA_NAME,
    created_at: new Date().toISOString(),
    raw_response_text: response.rawResponseText,
    extracted_content: response.extractedContent,
  }))
}

export async function runDocumentProfile(params: {
  targetSp: string
  model: ModelConfig
  apiKey: string
  reviewId: string
  signal?: AbortSignal
}): Promise<{
  documentProfile: DocumentProfile
  rawModelOutputs: RawModelOutput[]
}> {
  const adapter = getProviderAdapter(params.model.provider)
  const result = await retryWithErrorFeedback({
    adapter,
    request: {
      baseUrl: params.model.baseUrl,
      apiKey: params.apiKey,
      modelId: params.model.modelId,
      signal: params.signal,
      messages: [
        { role: 'system', content: BUTLER_DOCUMENT_PROFILE_SYSTEM_PROMPT },
        { role: 'user', content: buildDocumentProfilePrompt(params.targetSp) },
      ],
    },
    schemaName: DOCUMENT_PROFILE_SCHEMA_NAME,
    validate: (raw) => {
      const parsed = parseJsonObject<DocumentProfile>(raw)
      if (!validateDocumentProfile(parsed)) {
        throw new Error(ajv.errorsText(validateDocumentProfile.errors))
      }
    },
  })

  const parsed = parseJsonObject<DocumentProfile>(result.content)
  if (!validateDocumentProfile(parsed)) {
    throw new Error(`文档画像未通过Schema校验：${ajv.errorsText(validateDocumentProfile.errors)}`)
  }

  return {
    documentProfile: parsed,
    rawModelOutputs: buildRawModelOutputs({
      reviewId: params.reviewId,
      modelId: params.model.modelId,
      rawResponses: result.rawResponses,
    }),
  }
}
