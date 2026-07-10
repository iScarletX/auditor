import { Editor } from '@monaco-editor/react'
import { FileText, FolderUp, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import {
  importDirectory,
  importSingleOrZipFile,
  type ImportResult,
} from '../../core/fileImport/importSource'
import { Button } from '../ui/Button'

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
}

export function PromptInput({ value, onChange }: PromptInputProps) {
  const characters = value.length
  const lines = value.length ? value.split('\n').length : 0
  const fileInputRef = useRef<HTMLInputElement>(null)
  const directoryInputRef = useRef<HTMLInputElement>(null)
  const [importInfo, setImportInfo] = useState<{ fileCount: number; skipped: string[] } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const applyImportResult = (result: ImportResult) => {
    setImportError(null)
    if (!result.ok) {
      setImportError(result.error ?? '导入失败，请检查文件内容。')
      setImportInfo(null)
      return
    }
    onChange(result.targetSp)
    setImportInfo({ fileCount: result.files.length, skipped: result.skipped })
  }

  const handleFileSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    // 单文件 input（accept 未限制 webkitdirectory）：可能是单个文本文件，也可能是 zip
    const file = fileList[0]
    const result = await importSingleOrZipFile(file)
    applyImportResult(result)
  }

  const handleDirectorySelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const result = await importDirectory(fileList)
    applyImportResult(result)
  }

  const clearImportInfo = () => {
    setImportInfo(null)
    setImportError(null)
  }

  return (
    <section className="flex min-h-[430px] flex-col overflow-hidden rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">System Prompt / Skill</h2>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-slate-500">
            {characters.toLocaleString()} 字符 · {lines.toLocaleString()} 行
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => fileInputRef.current?.click()}
              title="支持单个文本文件（.md/.txt）或 .zip 压缩包"
            >
              <Upload className="h-3.5 w-3.5" />
              上传文件
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => directoryInputRef.current?.click()}
              title="选择整个 Skill 文件夹，自动识别其中所有文本文件"
            >
              <FolderUp className="h-3.5 w-3.5" />
              上传文件夹
            </Button>
          </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.txt,.zip,.yaml,.yml,.json"
        className="hidden"
        onChange={(event) => {
          void handleFileSelected(event.target.files)
          event.target.value = ''
        }}
      />
      <input
        ref={directoryInputRef}
        type="file"
        // webkitdirectory 是浏览器原生支持的文件夹选择属性，无需额外依赖
        // @ts-expect-error React 类型定义未收录 webkitdirectory，但主流浏览器均已支持
        webkitdirectory="true"
        multiple
        className="hidden"
        onChange={(event) => {
          void handleDirectorySelected(event.target.files)
          event.target.value = ''
        }}
      />

      {importInfo ? (
        <div className="flex items-start gap-2 border-b border-emerald-100 bg-emerald-50 px-4 py-2 text-xs text-emerald-800">
          <span className="flex-1">
            已识别 {importInfo.fileCount} 个文件并自动拼装
            {importInfo.skipped.length > 0
              ? `，跳过 ${importInfo.skipped.length} 个非文本文件（${importInfo.skipped.slice(0, 3).join('、')}${importInfo.skipped.length > 3 ? ' 等' : ''}）`
              : ''}
            。下方编辑框内容已更新，可直接微调后再审查。
          </span>
          <button type="button" onClick={clearImportInfo} className="rounded p-0.5 hover:bg-emerald-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      {importError ? (
        <div className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-800">
          <span className="flex-1">{importError}</span>
          <button type="button" onClick={clearImportInfo} className="rounded p-0.5 hover:bg-red-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

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
