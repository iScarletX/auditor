import { DiffEditor } from '@monaco-editor/react'
import { AlertTriangle, Check, X } from 'lucide-react'
import type { DiffResult } from '../../core/fixApplier/generateDiff'
import type { Issue } from '../../types/reviewReport.types'
import { Button } from '../ui/Button'

interface DiffPreviewProps {
  issue: Issue | null
  diff: DiffResult | null
  onConfirm: () => void
  onCancel: () => void
}

export function DiffPreview({ issue, diff, onConfirm, onCancel }: DiffPreviewProps) {
  if (!issue || !diff) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <div className="flex h-[86vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">修改建议预览</h2>
            <p className="mt-1 text-xs text-slate-500">{issue.skill_id} · {issue.id}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label="关闭">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {!diff.ok ? (
          <div className="m-4 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">需要人工确认具体位置</div>
              <div className="mt-1 text-xs">{diff.reason}</div>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          <DiffEditor
            height="100%"
            language="markdown"
            original={diff.before}
            modified={diff.after}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              wordWrap: 'on',
              automaticLayout: true,
            }}
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <Button type="button" variant="secondary" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" onClick={onConfirm} disabled={!diff.ok}>
            <Check className="h-4 w-4" />
            确认应用
          </Button>
        </div>
      </div>
    </div>
  )
}
