import { ChevronDown, MessageSquareText } from 'lucide-react'
import { useState } from 'react'

interface ScenarioHintInputProps {
  value: string
  onChange: (value: string) => void
}

/**
 * 补充说明（选填）：系统会自动理解文档用途（文档画像）；
 * 这个输入框是纠偏工具——用户提供的说明会注入每一次检查调用（scenario_hint），
 * 影响严重程度判断和 not_applicable 判定，优先级高于自动推断。
 */
export function ScenarioHintInput({ value, onChange }: ScenarioHintInputProps) {
  const [open, setOpen] = useState(Boolean(value.trim()))

  return (
    <section className="rounded-2xl border border-[#e1e3e1] bg-white shadow-m3">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        onClick={() => setOpen((current) => !current)}
      >
        <MessageSquareText className="h-4 w-4 text-slate-500" />
        <span className="flex-1 text-sm font-semibold text-slate-950">
          补充说明
          <span className="ml-2 text-xs font-normal text-slate-400">选填</span>
          {value.trim() && !open ? (
            <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
              已填写，将影响审查判断
            </span>
          ) : null}
        </span>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="border-t border-slate-100 p-4">
          <p className="mb-2 text-xs leading-5 text-slate-500">
            系统会自动理解文档用途。如果自动理解有偏差，或有文档里看不出来的背景（例如"仅内部使用，无外部输入"、
            "输出会被程序直接解析"），在这里补充。你的说明会直接参与每一项检查的判断，优先级高于自动推断。
          </p>
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="例如：这个提示词只在公司内部工具中使用，用户都是自己团队的人"
            className="min-h-20 w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-sm leading-6 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          />
        </div>
      ) : null}
    </section>
  )
}
