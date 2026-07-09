import { KeyRound, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
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

function uniqueModels(models: ModelConfig[]) {
  const seen = new Set<string>()
  return models.filter((model) => {
    const key = `${model.provider}:${model.baseUrl}:${model.modelId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
  const [customOpen, setCustomOpen] = useState(false)
  const [customLabel, setCustomLabel] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customModelId, setCustomModelId] = useState('')
  const [modelSearch, setModelSearch] = useState('')
  const selectedModels = models.filter((model) => model.selected).slice(0, 3)
  const selectedKeys = new Set(selectedModels.map((model) => `${model.provider}:${model.baseUrl}:${model.modelId}`))
  const selectedCount = selectedModels.length
  const modelChoices = useMemo(
    () => uniqueModels([
      ...selectedModels,
      ...availableModels,
      ...DEFAULT_MODELS.map((model) => ({ ...model, selected: false })),
    ]),
    [availableModels, selectedModels],
  )
  const filteredModelChoices = useMemo(() => {
    const keyword = modelSearch.trim().toLowerCase()
    if (!keyword) return modelChoices
    return modelChoices.filter(
      (model) => model.label.toLowerCase().includes(keyword) || model.modelId.toLowerCase().includes(keyword),
    )
  }, [modelChoices, modelSearch])

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

  const toggleModel = (model: ModelConfig) => {
    const key = `${model.provider}:${model.baseUrl}:${model.modelId}`
    if (selectedKeys.has(key)) {
      onChange(selectedModels.filter((item) => `${item.provider}:${item.baseUrl}:${item.modelId}` !== key))
      return
    }
    if (selectedModels.length >= 3) return
    onChange([...selectedModels, { ...model, selected: true }])
  }

  const addCustomModel = () => {
    const baseUrl = customBaseUrl.trim()
    const modelId = customModelId.trim()
    if (!baseUrl || !modelId || selectedModels.length >= 3) return
    const model: ModelConfig = {
      id: `custom-${crypto.randomUUID()}`,
      label: customLabel.trim() || modelId,
      provider: 'custom',
      baseUrl,
      modelId,
      selected: true,
    }
    onChange([...selectedModels, model])
    setCustomLabel('')
    setCustomBaseUrl('')
    setCustomModelId('')
    setCustomOpen(false)
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

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <FieldLabel>检查官模型</FieldLabel>
            <span className="text-xs text-slate-500">{selectedCount}/3</span>
          </div>
          <p className="text-xs leading-5 text-slate-500">
            检查官模型负责执行语义类审查项。可选 1–3 个：1 个速度最快但无交叉验证，判断仅作参考；2–3 个可相互比对，仅当多个模型一致时才确认为确定问题，可靠度更高。
          </p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={modelSearch}
              onChange={(event) => setModelSearch(event.target.value)}
              placeholder="搜索模型名称或id"
              className="h-8 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-xs text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
            />
          </div>
          <div className="max-h-56 space-y-2 overflow-auto rounded-md border border-slate-200 p-2">
            {filteredModelChoices.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-slate-400">没有匹配的模型</p>
            ) : null}
            {filteredModelChoices.map((model) => {
              const key = `${model.provider}:${model.baseUrl}:${model.modelId}`
              const checked = selectedKeys.has(key)
              const disabled = !checked && selectedCount >= 3
              return (
                <label
                  key={key}
                  className={`flex items-start gap-2 rounded-md px-2 py-2 text-sm transition ${
                    disabled ? 'text-slate-400' : 'text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleModel(model)}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{model.label}</span>
                    <span className="block truncate text-xs text-slate-500">{model.modelId}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </div>

        <div className="rounded-md border border-slate-200">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-slate-900"
            onClick={() => setCustomOpen((value) => !value)}
          >
            <Plus className="h-4 w-4 text-slate-500" />
            自定义兼容端点
          </button>
          {customOpen ? (
            <div className="space-y-2 border-t border-slate-200 p-3">
              <Input value={customLabel} placeholder="显示名称（可选）" onChange={(event) => setCustomLabel(event.target.value)} />
              <Input value={customBaseUrl} placeholder="Base URL，例如 https://api.example.com/v1" onChange={(event) => setCustomBaseUrl(event.target.value)} />
              <Input value={customModelId} placeholder="Model ID" onChange={(event) => setCustomModelId(event.target.value)} />
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={addCustomModel}
                disabled={!customBaseUrl.trim() || !customModelId.trim() || selectedCount >= 3}
              >
                添加并选择
              </Button>
            </div>
          ) : null}
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
