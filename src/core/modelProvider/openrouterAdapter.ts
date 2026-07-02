import type { ChatCompletionRequest, ProviderAdapter } from './providerAdapter'

interface ChatCompletionChoice {
  message?: {
    content?: string
  }
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[]
  error?: {
    message?: string
  }
}

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`
}

export const openRouterAdapter: ProviderAdapter = {
  async chatCompletion(request: ChatCompletionRequest) {
    const response = await fetch(endpoint(request.baseUrl), {
      method: 'POST',
      signal: request.signal,
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Butler Local',
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    })

    const json = (await response.json()) as ChatCompletionResponse
    if (!response.ok) {
      throw new Error(json.error?.message ?? `模型请求失败：HTTP ${response.status}`)
    }

    const content = json.choices?.[0]?.message?.content
    if (!content) throw new Error('模型返回为空')
    return content
  },
}
