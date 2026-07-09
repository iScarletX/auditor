import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ModelConfig } from '../../types/reviewReport.types'

function uniqueModels(models: ModelConfig[]) {
  const seen = new Set<string>()
  return models.filter((model) => {
    const key = `${model.provider}:${model.baseUrl}:${model.modelId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

interface ModelSearchListProps {
  selectedModels: ModelConfig[]
  availableModels: ModelConfig[]
  selectedKeys: Set<string>
  selectedCount: number
  /** 检查官模型最多3个；最终把关模型不设上限(单选) */
  maxCount?: number
  onToggle: (model: ModelConfig) => void
  placeholder?: string
}

/** 检查官模型/最终把关模型共用的"搜索+勾选"列表：打通同一份完整模型池，不再各自只能搜到已选的几个 */
export function ModelSearchList({
  selectedModels,
  availableModels,
  selectedKeys,
  selectedCount,
  maxCount,
  onToggle,
  placeholder = '搜索模型名称或id',
}: ModelSearchListProps) {
  const [search, setSearch] = useState('')
  const modelChoices = useMemo(
    () => uniqueModels([...selectedModels, ...availableModels]),
    [availableModels, selectedModels],
  )
  const filteredModelChoices = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return modelChoices
    return modelChoices.filter(
      (model) => model.label.toLowerCase().includes(keyword) || model.modelId.toLowerCase().includes(keyword),
    )
  }, [modelChoices, search])

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={placeholder}
          className="h-8 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-xs text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
        />
      </div>
      <div className="max-h-56 space-y-1 overflow-auto rounded-md border border-slate-200 p-2">
        {filteredModelChoices.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-slate-400">没有匹配的模型</p>
        ) : null}
        {filteredModelChoices.map((model) => {
          const key = `${model.provider}:${model.baseUrl}:${model.modelId}`
          const checked = selectedKeys.has(key)
          const disabled = !checked && maxCount !== undefined && selectedCount >= maxCount
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
                onChange={() => onToggle(model)}
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
  )
}
