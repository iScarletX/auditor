import { Editor } from '@monaco-editor/react'
import { FileText } from 'lucide-react'

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
}

export function PromptInput({ value, onChange }: PromptInputProps) {
  const characters = value.length
  const lines = value.length ? value.split('\n').length : 0

  return (
    <section className="flex min-h-[430px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">System Prompt</h2>
        </div>
        <div className="text-xs text-slate-500">
          {characters.toLocaleString()} 字符 · {lines.toLocaleString()} 行
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          height="390px"
          language="markdown"
          value={value}
          onChange={(next) => onChange(next ?? '')}
          options={{
            minimap: { enabled: false },
            lineNumbers: 'on',
            wordWrap: 'on',
            automaticLayout: true,
            fontSize: 13,
            padding: { top: 12, bottom: 12 },
          }}
        />
      </div>
    </section>
  )
}
