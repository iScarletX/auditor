import type { ModelConfig } from '../../types/reviewReport.types'

const MODEL_RANKING = [
  'anthropic/claude-opus-4',
  'anthropic/claude-sonnet-4',
  'openai/gpt-4.1',
  'openai/gpt-4o',
  'google/gemini-2.5-pro',
  'deepseek/deepseek-chat',
  'meta-llama/llama-3.3-70b-instruct',
]

function rankOf(modelId: string) {
  const exact = MODEL_RANKING.indexOf(modelId)
  if (exact >= 0) return exact
  const fuzzy = MODEL_RANKING.findIndex((ranked) => modelId.includes(ranked) || ranked.includes(modelId))
  return fuzzy >= 0 ? fuzzy : MODEL_RANKING.length
}

export function selectConsolidationModel(params: {
  selectedModels: ModelConfig[]
  manualModelId?: string | null
}): {
  model: ModelConfig | null
  source: 'auto_selected' | 'user_specified'
} {
  const selected = params.selectedModels.filter((model) => model.selected)
  const manual = params.manualModelId
    ? selected.find((model) => model.id === params.manualModelId || model.modelId === params.manualModelId)
    : null

  if (manual) {
    return {
      model: manual,
      source: 'user_specified',
    }
  }

  const model = [...selected].sort((a, b) => rankOf(a.modelId) - rankOf(b.modelId))[0] ?? null
  return {
    model,
    source: 'auto_selected',
  }
}
