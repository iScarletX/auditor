import { MessageSquareText } from 'lucide-react'

interface ScenarioHintInputProps {
  value: string
  onChange: (value: string) => void
}

export function ScenarioHintInput({ value, onChange }: ScenarioHintInputProps) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <MessageSquareText className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-950">实际使用场景</h2>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="可选：例如这个 SP 会用于客服机器人、内部审核、代码生成、表单抽取等"
        className="min-h-24 w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-sm leading-6 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
      />
    </section>
  )
}
