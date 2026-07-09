import { ChevronDown, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { selectConsolidationModel } from '../../core/orchestrator/consolidationModelSelector'
import type { ModelConfig } from '../../types/reviewReport.types'
import { ModelSearchList } from '../ModelSelector/ModelSearchList'

interface ConsolidationModelPickerProps {
  /** 已选的检查官模型：自动推荐仍优先从这里挑，符合"跑完检查后由参与检查的模型之一把关"的默认逻辑 */
  models: ModelConfig[]
  /** 完整可用模型列表：与检查官模型共享同一份数据源，可手动指定为任意模型，不再局限于已选的几个 */
  availableModels: ModelConfig[]
  value: string | null
  onChange: (value: string | null) => void
}

export function ConsolidationModelPicker({ models, availableModels, value, onChange }: ConsolidationModelPickerProps) {
  const [open, setOpen] = useState(false)
  const selectedModels = models.filter((model) => model.selected)

  // 自动推荐结果：不再展示"系统自动选择"这种空话，直接算出未手动指定时实际会用哪个模型
  const autoSelection = selectConsolidationModel({ selectedModels, manualModelId: null })
  const manualModel = value
    ? [...selectedModels, ...availableModels].find((model) => model.id === value || model.modelId === value)
    : null
  const effectiveModel = manualModel ?? autoSelection.model

  const selectedKeys = new Set(manualModel ? [`${manualModel.provider}:${manualModel.baseUrl}:${manualModel.modelId}`] : [])

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((current) => !current)}
      >
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">最终把关模型</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {effectiveModel ? effectiveModel.label : '待选检查官模型'}
            {!manualModel && effectiveModel ? '（推荐）' : null}
          </span>
          <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {open ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs leading-5 text-slate-500">
            检查跑完后，该模型负责独立复核、补充遗漏的问题、合并重复项，并生成最终处方。默认自动推荐上方展示的模型，也可在下方搜索并指定其他模型。
          </p>
          <ModelSearchList
            selectedModels={manualModel ? [manualModel] : []}
            availableModels={[...selectedModels, ...availableModels]}
            selectedKeys={selectedKeys}
            selectedCount={selectedKeys.size}
            maxCount={1}
            onToggle={(model) => {
              const key = `${model.provider}:${model.baseUrl}:${model.modelId}`
              const isSame = selectedKeys.has(key)
              onChange(isSame ? null : model.id)
            }}
            placeholder="搜索模型名称或id，指定后不再自动推荐"
          />
        </div>
      ) : null}
    </section>
  )
}
