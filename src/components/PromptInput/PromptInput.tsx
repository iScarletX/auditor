import { FileText } from 'lucide-react'

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
}

export function PromptInput({ value, onChange }: PromptInputProps) {
  const characters = value.length
  const lines = value.length ? value.split('\n').length : 0

  return (
    <section className="flex min-h-[520px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">Target System Prompt</h2>
        </div>
        <div className="text-xs text-slate-500">
          {characters.toLocaleString()} 字符 · {lines.toLocaleString()} 行
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-slate-950/95 p-0">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          placeholder="把要审查的 System Prompt 粘贴到这里"
          className="h-full min-h-[470px] w-full resize-none border-0 bg-slate-950 px-5 py-4 font-mono text-[13px] leading-6 text-slate-100 outline-none placeholder:text-slate-500"
        />
      </div>
    </section>
  )
}
