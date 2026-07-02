import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import type { ModelConfig } from '../../types/reviewReport.types'
import { DEFAULT_MODELS, listOpenRouterModels } from '../../core/modelProvider/providerAdapter'
import { Button } from '../ui/Button'
import { FieldLabel, Input } from '../ui/Field'

interface ModelSelectorProps {
  models: ModelConfig[]
  onChange: (models: ModelConfig[]) => void
  hasStoredApiKey: boolean
  apiKeyMask: string
  onSaveApiKey: (value: string) => Promise<void>
  onLoadStoredApiKey: () => Promise<string | null>
}

export function ModelSelector({
  models,
  onChange,
  hasStoredApiKey,
  apiKeyMask,
  onSaveApiKey,
  onLoadStoredApiKey,
}: ModelSelectorProps) {
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingKey, setEditingKey] = useState(!hasStoredApiKey)
  const [availableModels, setAvailableModels] = useState<ModelConfig[]>(
    DEFAULT_MODELS.map((model) => ({ ...model, selected: false })),
  )
  const [modelStatus, setModelStatus] = useState<string | null>(null)
  const selectedModels = models.filter((model) => model.selected).slice(0, 3)
  const selectedIds = selectedModels.map((model) => model.id)
  const selectedCount = selectedModels.length
  const modelChoices = [
    ...selectedModels.filter((model) => !availableModels.some((option) => option.id === model.id)),
    ...availableModels,
  ]

  const refreshModels = async (apiKey: string | null) => {
    if (!apiKey) {
      setModelStatus('请先保存 OpenRouter API Key')
      return
    }
    setModelStatus('正在读取 OpenRouter 模型列表...')
    try {
      const fetchedModels = await listOpenRouterModels(apiKey)
      setAvailableModels(fetchedModels)
      setModelStatus(`已读取 ${fetchedModels.length.toLocaleString()} 个可用模型`)
    } catch {
      setAvailableModels(DEFAULT_MODELS.map((model) => ({ ...model, selected: false })))
      setModelStatus('暂时无法读取完整模型列表，已使用默认模型')
    }
  }

  const updateSelectionSlot = (slotIndex: number, modelId: string) => {
    const nextIds = [...selectedIds]
    if (modelId) nextIds[slotIndex] = modelId
    else nextIds.splice(slotIndex, 1)

    const uniqueIds = nextIds.filter(Boolean).filter((id, index, list) => list.indexOf(id) === index).slice(0, 3)
    const nextModels = uniqueIds
      .map((id) => modelChoices.find((model) => model.id === id))
      .filter((model): model is ModelConfig => Boolean(model))
      .map((model) => ({ ...model, selected: true }))

    onChange(nextModels)
  }

  const saveKey = async () => {
    if (!apiKeyDraft.trim()) return
    setSaving(true)
    setModelStatus(null)
    try {
      const key = apiKeyDraft.trim()
      await onSaveApiKey(key)
      setApiKeyDraft('')
      setEditingKey(false)
      await refreshModels(key)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">模型与密钥</h2>
        </div>
        {hasStoredApiKey ? (
          <span className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
            已加密保存
          </span>
        ) : (
          <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
            未保存 Key
          </span>
        )}
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <FieldLabel>API Key</FieldLabel>
          {hasStoredApiKey && !editingKey ? (
            <div className="flex gap-2">
              <Input value={apiKeyMask} readOnly aria-label="已保存的打码 API Key" />
              <Button
                type="button"
                variant="secondary"
                onClick={async () => {
                  setSaving(true)
                  try {
                    await refreshModels(await onLoadStoredApiKey())
                  } finally {
                    setSaving(false)
                  }
                }}
                disabled={saving}
              >
                读取模型
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditingKey(true)}>
                更换
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                type="password"
                value={apiKeyDraft}
                placeholder={hasStoredApiKey ? '输入新 Key 可覆盖已保存密钥' : 'OpenRouter API Key'}
                onChange={(event) => setApiKeyDraft(event.target.value)}
              />
              <Button type="button" variant="secondary" onClick={saveKey} disabled={!apiKeyDraft.trim() || saving}>
                保存
              </Button>
            </div>
          )}
        </div>

        {selectedCount === 1 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            仅选择 1 个模型时，LLM 判断都会标记为单模型标记，建议至少选择 2 个模型。
          </div>
        ) : null}

        <div className="grid gap-2">
          {[0, 1, 2].map((slotIndex) => (
            <div key={slotIndex} className="grid gap-1.5">
              <FieldLabel>{`检查官 ${slotIndex + 1}`}</FieldLabel>
              <select
                value={selectedIds[slotIndex] ?? ''}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                onChange={(event) => updateSelectionSlot(slotIndex, event.target.value)}
              >
                <option value="">{slotIndex === 0 ? '选择模型' : '不启用'}</option>
                {modelChoices.map((model) => {
                  const alreadyUsed = selectedIds.includes(model.id) && selectedIds[slotIndex] !== model.id
                  return (
                    <option key={model.id} value={model.id} disabled={alreadyUsed}>
                      {model.label}
                    </option>
                  )
                })}
              </select>
            </div>
          ))}
        </div>

        {modelStatus ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {modelStatus}
          </div>
        ) : null}
      </div>
    </section>
  )
}
