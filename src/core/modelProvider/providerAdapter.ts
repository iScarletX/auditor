import type { ModelConfig, ProviderKind } from '../../types/reviewReport.types'
import { customEndpointAdapter } from './customEndpointAdapter'
import { openRouterAdapter } from './openrouterAdapter'

export interface ProviderMessage {
  role: 'system' | 'user'
  content: string
}

export interface ChatCompletionRequest {
  baseUrl: string
  apiKey: string
  modelId: string
  messages: ProviderMessage[]
  signal?: AbortSignal
}

export interface ProviderAdapter {
  chatCompletion(request: ChatCompletionRequest): Promise<string>
}

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export const DEFAULT_MODELS: ModelConfig[] = [
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet',
    provider: 'openrouter',
    baseUrl: DEFAULT_OPENROUTER_BASE_URL,
    modelId: 'anthropic/claude-sonnet-4',
    selected: true,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'openrouter',
    baseUrl: DEFAULT_OPENROUTER_BASE_URL,
    modelId: 'openai/gpt-4o',
    selected: true,
  },
  {
    id: 'deepseek-v3',
    label: 'DeepSeek V3',
    provider: 'openrouter',
    baseUrl: DEFAULT_OPENROUTER_BASE_URL,
    modelId: 'deepseek/deepseek-chat',
    selected: true,
  },
]

interface OpenRouterModelRecord {
  id?: unknown
  name?: unknown
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelRecord[]
}

export async function listOpenRouterModels(apiKey?: string): Promise<ModelConfig[]> {
  const response = await fetch(`${DEFAULT_OPENROUTER_BASE_URL}/models`, {
    headers: apiKey
      ? {
          Authorization: `Bearer ${apiKey}`,
        }
      : undefined,
  })

  if (!response.ok) {
    throw new Error(`读取 OpenRouter 模型列表失败：HTTP ${response.status}`)
  }

  const json = (await response.json()) as OpenRouterModelsResponse
  const rows = Array.isArray(json.data) ? json.data : []
  const models = rows
    .filter((model) => typeof model.id === 'string')
    .map((model) => ({
      id: String(model.id),
      label: typeof model.name === 'string' && model.name ? model.name : String(model.id),
      provider: 'openrouter' as const,
      baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      modelId: String(model.id),
      selected: false,
    }))

  return models.length > 0 ? models : DEFAULT_MODELS.map((model) => ({ ...model, selected: false }))
}

export function getProviderAdapter(provider: ProviderKind): ProviderAdapter {
  if (provider === 'openrouter') return openRouterAdapter
  return customEndpointAdapter
}
