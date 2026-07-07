import type { ChatCompletionRequest, ProviderAdapter, ProviderMessage } from '../modelProvider/providerAdapter'
import { ModelProviderError } from '../modelProvider/providerAdapter'
import { buildStrictJsonReminder } from './strictFormatRequest'

export interface RetryRawResponse {
  attempt: number
  rawResponseText: string
  extractedContent?: string
}

export interface RetryWithErrorFeedbackResult {
  content: string
  rawResponses: RetryRawResponse[]
}

export class RetryWithFeedbackError extends Error {
  rawResponses: RetryRawResponse[]

  constructor(message: string, rawResponses: RetryRawResponse[]) {
    super(message)
    this.name = 'RetryWithFeedbackError'
    this.rawResponses = rawResponses
  }
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : '模型请求失败'
}

export async function retryWithErrorFeedback(params: {
  adapter: ProviderAdapter
  request: ChatCompletionRequest
  schemaName: string
  validate: (content: string) => void
}): Promise<RetryWithErrorFeedbackResult> {
  const rawResponses: RetryRawResponse[] = []

  let first
  try {
    first = await params.adapter.chatCompletion(params.request)
    rawResponses.push({
      attempt: 1,
      rawResponseText: first.rawResponseText,
      extractedContent: first.content,
    })
  } catch (error) {
    if (error instanceof ModelProviderError && error.rawResponseText) {
      rawResponses.push({
        attempt: 1,
        rawResponseText: error.rawResponseText,
      })
    }
    throw new RetryWithFeedbackError(messageFromError(error), rawResponses)
  }

  try {
    params.validate(first.content)
    return {
      content: first.content,
      rawResponses,
    }
  } catch {
    const reminder: ProviderMessage = {
      role: 'user',
      content: buildStrictJsonReminder(params.schemaName),
    }
    try {
      const second = await params.adapter.chatCompletion({
        ...params.request,
        messages: [...params.request.messages, reminder],
      })
      rawResponses.push({
        attempt: 2,
        rawResponseText: second.rawResponseText,
        extractedContent: second.content,
      })
      params.validate(second.content)
      return {
        content: second.content,
        rawResponses,
      }
    } catch (error) {
      if (error instanceof ModelProviderError && error.rawResponseText) {
        rawResponses.push({
          attempt: 2,
          rawResponseText: error.rawResponseText,
        })
      }
      throw new RetryWithFeedbackError(messageFromError(error), rawResponses)
    }
  }
}
