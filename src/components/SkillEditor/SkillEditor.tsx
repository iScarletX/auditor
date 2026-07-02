import { Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { lintAndSaveUserSkill } from '../../core/skillLoader/loadUserSkills'
import type { SkillDefinition } from '../../types/reviewReport.types'
import { Button } from '../ui/Button'

interface SkillEditorProps {
  onSkillAdded: (skill: SkillDefinition) => void
}

export function SkillEditor({ onSkillAdded }: SkillEditorProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [messages, setMessages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const handleFile = async (file: File) => {
    setBusy(true)
    try {
      const content = await file.text()
      const result = await lintAndSaveUserSkill(content)
      if (!result.ok || !result.skill) {
        setMessages(result.errors)
        return
      }
      onSkillAdded(result.skill)
      setMessages([
        `已加载 ${result.skill.title}`,
        ...result.warnings.map((warning) => `警告：${warning}`),
      ])
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept=".md,.txt"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleFile(file)
        }}
      />
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-4 w-4" />
        上传自定义 Skill
      </Button>
      {messages.length > 0 ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          {messages.map((message) => (
            <div key={message}>{message}</div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
