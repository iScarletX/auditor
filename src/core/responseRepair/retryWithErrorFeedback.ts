import type { ChatCompletionRequest, ProviderAdapter, ProviderMessage } from '../modelProvider/providerAdapter'
import { buildStrictJsonReminder } from './strictFormatRequest'

export async function retryWithErrorFeedback(params: {
  adapter: ProviderAdapter
  request: ChatCompletionRequest
  schemaName: string
  validate: (content: string) => void
}): Promise<string> {
  const first = await params.adapter.chatCompletion(params.request)
  try {
    params.validate(first)
    return first
  } catch {
    const reminder: ProviderMessage = {
      role: 'user',
      content: buildStrictJsonReminder(params.schemaName),
    }
    const second = await params.adapter.chatCompletion({
      ...params.request,
      messages: [...params.request.messages, reminder],
    })
    params.validate(second)
    return second
  }
}
