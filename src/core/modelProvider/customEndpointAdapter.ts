import type { ChatCompletionRequest, ProviderAdapter } from './providerAdapter'

interface CustomChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
  }
}

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`
}

export const customEndpointAdapter: ProviderAdapter = {
  async chatCompletion(request: ChatCompletionRequest) {
    const response = await fetch(endpoint(request.baseUrl), {
      method: 'POST',
      signal: request.signal,
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    })

    const json = (await response.json()) as CustomChatCompletionResponse
    if (!response.ok) {
      throw new Error(json.error?.message ?? `自定义端点请求失败：HTTP ${response.status}`)
    }

    const content = json.choices?.[0]?.message?.content
    if (!content) throw new Error('自定义端点返回为空')
    return content
  },
}
