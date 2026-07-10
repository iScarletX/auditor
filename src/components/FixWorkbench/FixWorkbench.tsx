import { Check, Download, Loader2, Pencil, RotateCcw, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { FixPlan } from '../../core/orchestrator/fixPlanGenerator'
import type { PrescriptionPriorityAction } from '../../types/reviewReport.types'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'

/**
 * 整体修改工作台：完整原文铺开，问题位置标红，正下方绿色展示建议改法。
 * 每一处可单独 应用/编辑后应用/忽略，也可一键全部应用；最后导出修改后的完整文档。
 * 设计原则(与用户对齐)：修改必须"把输入的内容整体去看"，不能只在弹窗里一条条脱离上下文地改。
 */

type EditState = 'pending' | 'applied' | 'ignored'

interface EditRuntime {
  state: EditState
  effectiveAfter: string
}

interface FixWorkbenchProps {
  targetSp: string
  fixPlans: FixPlan[]
  actions: PrescriptionPriorityAction[]
  loading: boolean
  error: string | null
  onClose: () => void
}

interface EditEntry {
  key: string
  actionPriority: number
  problemStatement: string
  beforeText: string
  afterText: string
  note: string
  /** 定位到原文的起始行(找不到时为null，展示在顶部的"未定位"区) */
  lineIndex: number | null
}

function normalizeCompact(value: string) {
  return value.replace(/\s+/g, '')
}

export function FixWorkbench({ targetSp, fixPlans, actions, loading, error, onClose }: FixWorkbenchProps) {
  const [runtimes, setRuntimes] = useState<Map<string, EditRuntime>>(new Map())
  const [editingKey, setEditingKey] = useState<string | null>(null)

  const lines = useMemo(() => targetSp.split('\n'), [targetSp])

  // 把每条edit定位到原文行号
  const editEntries = useMemo<EditEntry[]>(() => {
    const lineStartOffsets: number[] = []
    let offset = 0
    for (const line of lines) {
      lineStartOffsets.push(offset)
      offset += line.length + 1
    }
    const offsetToLine = (index: number) => {
      for (let i = lineStartOffsets.length - 1; i >= 0; i -= 1) {
        if (index >= lineStartOffsets[i]) return i
      }
      return 0
    }

    const entries: EditEntry[] = []
    for (const plan of fixPlans) {
      const action = actions.find((item) => item.priority === plan.action_priority)
      plan.edits.forEach((edit, index) => {
        const rawIndex = targetSp.indexOf(edit.before_text.trim())
        entries.push({
          key: `${plan.action_priority}-${index}`,
          actionPriority: plan.action_priority,
          problemStatement: action?.problem_statement ?? '',
          beforeText: edit.before_text,
          afterText: edit.after_text,
          note: edit.note,
          lineIndex: rawIndex >= 0 ? offsetToLine(rawIndex) : null,
        })
      })
    }
    return entries
  }, [fixPlans, actions, targetSp, lines])

  // 行号 → 该行携带的edit列表
  const editsByLine = useMemo(() => {
    const map = new Map<number, EditEntry[]>()
    for (const entry of editEntries) {
      if (entry.lineIndex === null) continue
      const list = map.get(entry.lineIndex) ?? []
      list.push(entry)
      map.set(entry.lineIndex, list)
    }
    return map
  }, [editEntries])

  const unlocatedEntries = editEntries.filter((entry) => entry.lineIndex === null)

  const runtimeOf = (key: string, fallbackAfter: string): EditRuntime =>
    runtimes.get(key) ?? { state: 'pending', effectiveAfter: fallbackAfter }

  const setRuntime = (key: string, runtime: EditRuntime) => {
    setRuntimes((current) => {
      const next = new Map(current)
      next.set(key, runtime)
      return next
    })
  }

  const appliedCount = editEntries.filter((entry) => runtimeOf(entry.key, entry.afterText).state === 'applied').length
  const pendingCount = editEntries.filter((entry) => runtimeOf(entry.key, entry.afterText).state === 'pending').length

  const applyAll = () => {
    setRuntimes((current) => {
      const next = new Map(current)
      for (const entry of editEntries) {
        const existing = next.get(entry.key)
        if (existing?.state === 'ignored') continue
        next.set(entry.key, { state: 'applied', effectiveAfter: existing?.effectiveAfter ?? entry.afterText })
      }
      return next
    })
  }

  // 导出：按"已应用"的edit依次做文本替换
  const exportModified = () => {
    let output = targetSp
    for (const entry of editEntries) {
      const runtime = runtimeOf(entry.key, entry.afterText)
      if (runtime.state !== 'applied') continue
      const trimmed = entry.beforeText.trim()
      if (output.includes(trimmed)) {
        output = output.replace(trimmed, runtime.effectiveAfter)
      } else if (trimmed.length >= 8 && normalizeCompact(output).includes(normalizeCompact(trimmed))) {
        // 空白差异容错：找不到精确匹配时跳过(不敢盲改)
        continue
      }
    }
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'prompt-修改后.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const renderEditCard = (entry: EditEntry) => {
    const runtime = runtimeOf(entry.key, entry.afterText)
    const editing = editingKey === entry.key
    return (
      <div key={entry.key} className="ml-11 mr-3 my-2 rounded-lg border border-slate-200 bg-white shadow-sm">
        {entry.problemStatement ? (
          <p className="border-b border-slate-100 px-3 py-2 text-xs leading-5 text-slate-500">
            {entry.problemStatement.length > 80 ? `${entry.problemStatement.slice(0, 80)}…` : entry.problemStatement}
          </p>
        ) : null}
        <div className="space-y-1.5 p-3 font-mono text-xs">
          <div className="rounded bg-red-50 px-2 py-1.5 text-red-800 line-through decoration-red-300">
            {entry.beforeText}
          </div>
          {editing ? (
            <textarea
              className="w-full rounded border border-emerald-300 bg-white px-2 py-1.5 font-mono text-xs leading-5 text-emerald-900 outline-none focus:ring-2 focus:ring-emerald-200"
              rows={3}
              value={runtime.effectiveAfter}
              onChange={(event) => setRuntime(entry.key, { ...runtime, effectiveAfter: event.target.value })}
            />
          ) : (
            <div className="rounded bg-emerald-50 px-2 py-1.5 text-emerald-800">{runtime.effectiveAfter}</div>
          )}
          <p className="font-sans text-[11px] leading-4 text-slate-400">{entry.note}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2">
          {runtime.state === 'applied' ? (
            <>
              <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">
                <Check className="mr-1 h-3 w-3" />
                已应用
              </Badge>
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-slate-500 underline decoration-dotted underline-offset-2"
                onClick={() => setRuntime(entry.key, { ...runtime, state: 'pending' })}
              >
                <RotateCcw className="h-3 w-3" />
                撤销
              </button>
            </>
          ) : runtime.state === 'ignored' ? (
            <>
              <Badge>已忽略</Badge>
              <button
                type="button"
                className="text-xs text-slate-500 underline decoration-dotted underline-offset-2"
                onClick={() => setRuntime(entry.key, { ...runtime, state: 'pending' })}
              >
                恢复
              </button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => { setEditingKey(null); setRuntime(entry.key, { ...runtime, state: 'applied' }) }}>
                <Check className="h-3.5 w-3.5" />
                应用
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditingKey(editing ? null : entry.key)}>
                <Pencil className="h-3.5 w-3.5" />
                {editing ? '完成编辑' : '编辑'}
              </Button>
              <button
                type="button"
                className="text-xs text-slate-500 underline decoration-dotted underline-offset-2"
                onClick={() => setRuntime(entry.key, { ...runtime, state: 'ignored' })}
              >
                忽略
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={onClose}>
      <div
        className="flex h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">整体修改</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {loading
                ? '正在生成修改方案…'
                : `共 ${editEntries.length} 处修改建议 · 已应用 ${appliedCount} · 待处理 ${pendingCount}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!loading && pendingCount > 0 ? (
              <Button size="sm" variant="secondary" onClick={applyAll}>
                <Check className="h-3.5 w-3.5" />
                一键全部应用
              </Button>
            ) : null}
            {!loading && appliedCount > 0 ? (
              <Button size="sm" onClick={exportModified}>
                <Download className="h-3.5 w-3.5" />
                导出修改后文档
              </Button>
            ) : null}
            <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={onClose}>
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* 主体 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-500">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-sm">正在为每个问题位置生成修改建议，可能需要一分钟…</p>
            </div>
          ) : error ? (
            <div className="m-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          ) : editEntries.length === 0 ? (
            <div className="m-6 rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
              本次未能生成可自动应用的文字级修改（部分问题需要业务决策，请参考报告中的应对思路人工处理）。
            </div>
          ) : (
            <div className="px-2 py-3 font-mono text-xs leading-6">
              {unlocatedEntries.length > 0 ? (
                <div className="mx-3 mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 font-sans">
                  <p className="text-xs font-medium text-amber-900">
                    以下 {unlocatedEntries.length} 处修改建议未能在原文中精确定位（引用片段与原文有出入），请人工核对：
                  </p>
                  <div className="mt-2 space-y-2 font-mono">
                    {unlocatedEntries.map(renderEditCard)}
                  </div>
                </div>
              ) : null}
              {lines.map((line, index) => {
                const editsHere = editsByLine.get(index)
                if (!editsHere) {
                  return (
                    <div key={index} className="flex gap-3 px-3">
                      <span className="w-8 shrink-0 select-none text-right text-slate-300">{index + 1}</span>
                      <span className="whitespace-pre-wrap break-all text-slate-600">{line || ' '}</span>
                    </div>
                  )
                }
                return (
                  <div key={index}>
                    <div className="flex gap-3 rounded bg-red-50 px-3">
                      <span className="w-8 shrink-0 select-none text-right font-semibold text-red-500">{index + 1}</span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-medium text-slate-900">
                        {line || ' '}
                      </span>
                    </div>
                    {editsHere.map(renderEditCard)}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
