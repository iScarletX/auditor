import { ChevronDown, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { ModelConfig } from '../../types/reviewReport.types'
import { FieldLabel } from '../ui/Field'

interface ConsolidationModelPickerProps {
  models: ModelConfig[]
  value: string | null
  onChange: (value: string | null) => void
}

export function ConsolidationModelPicker({ models, value, onChange }: ConsolidationModelPickerProps) {
  const [open, setOpen] = useState(false)
  const selectedModels = models.filter((model) => model.selected)

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
        <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs leading-5 text-slate-500">
            检查跑完后，该模型负责独立复核、补充遗漏的问题、合并重复项，并生成最终处方。默认从已选的检查官模型中自动选取，也可手动指定。
          </p>
          <FieldLabel>手动指定</FieldLabel>
          <select
            value={value ?? ''}
            className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
            onChange={(event) => onChange(event.target.value || null)}
          >
            <option value="">系统自动选择</option>
            {selectedModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </section>
  )
}
