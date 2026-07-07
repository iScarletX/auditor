import { AlertTriangle, ChevronDown, ChevronRight, FileSearch, Globe, ListOrdered } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { IssueGroup, SeverityDisplay } from '../../types/reviewReport.types'
import { cn } from '../../lib/utils'
import { CATEGORY_LABELS } from '../../lib/categoryLabels'
import { Badge } from '../ui/Badge'

interface AnnotatedDocumentProps {
  targetSp: string
  issues: IssueGroup[]
  onOpenIssue: (issue: IssueGroup) => void
}

const severityDot: Record<string, string> = {
  严重: 'bg-red-500',
  中等: 'bg-amber-500',
  轻微: 'bg-slate-400',
}

const severityBadge: Record<string, string> = {
  严重: 'border-red-200 bg-red-50 text-red-700',
  中等: 'border-amber-200 bg-amber-50 text-amber-800',
  轻微: 'border-slate-200 bg-slate-50 text-slate-600',
}

const SEVERITY_ORDER: SeverityDisplay[] = ['严重', '中等', '轻微']

interface LocatedPosition {
  issueId: string
  lineIndex: number
  reason: string
  markerIndex: number
}

interface DocumentLayout {
  lines: string[]
  /** issueId -> 它命中的所有行号（去重排序） */
  linesByIssue: Map<string, number[]>
  /** lineIndex -> 指向该行的 (issueId, reason) 列表 */
  positionsByLine: Map<number, LocatedPosition[]>
  /** 整体性问题：所有位置都定位失败，或本来就没有具体锚点 */
  globalIssues: IssueGroup[]
  /** 定位性问题：至少有一处能锚到原文 */
  anchoredIssues: IssueGroup[]
}

function normalizeCompact(value: string) {
  return value.replace(/\s+/g, '')
}

/**
 * 整体性问题识别：一个 issue group 的所有位置都锚在第一行开头（模型习惯性引用开头做锚点），
 * 且它的类别属于"全文层面观察"（篇幅、风格、注入防御这类）时，视为整体性问题，
 * 不占用原文标记，上浮到汇总区顶部。
 */
const GLOBAL_PRONE_TITLES = /长度|篇幅|Token|预算|风格一致|注入防御|任务边界|过度约束|角色定位|自检|模型能力|可移植/i

function isGlobalIssue(issue: IssueGroup, locatedLines: number[]): boolean {
  if (locatedLines.length === 0) return true
  // 所有定位都落在第 1 行（开头引用），且标题属于全文观察类 → 整体性
  if (locatedLines.every((line) => line === 0) && GLOBAL_PRONE_TITLES.test(issue.title)) return true
  return false
}

function buildLayout(targetSp: string, issues: IssueGroup[]): DocumentLayout {
  const lines = targetSp.split('\n')
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

  const compactDoc = normalizeCompact(targetSp)
  const locateProbe = (probe: string | undefined | null): number | null => {
    const trimmed = (probe ?? '').trim()
    if (!trimmed) return null
    const index = targetSp.indexOf(trimmed)
    if (index !== -1) return offsetToLine(index)
    if (trimmed.length >= 8) {
      const compact = normalizeCompact(trimmed)
      const compactIndex = compactDoc.indexOf(compact)
      if (compactIndex !== -1) {
        let rawIndex = 0
        let compactCount = 0
        while (rawIndex < targetSp.length && compactCount < compactIndex) {
          if (!/\s/.test(targetSp[rawIndex])) compactCount += 1
          rawIndex += 1
        }
        return offsetToLine(rawIndex)
      }
    }
    return null
  }

  const linesByIssue = new Map<string, number[]>()
  const positionsByLine = new Map<number, LocatedPosition[]>()
  const globalIssues: IssueGroup[] = []
  const anchoredIssues: IssueGroup[] = []

  for (const issue of issues) {
    const issueLines: number[] = []
    const issuePositions: LocatedPosition[] = []
    for (const location of issue.locations) {
      const lineIndex =
        locateProbe(location.matched_text) ??
        locateProbe(location.anchor_before) ??
        locateProbe(location.anchor_after)
      if (lineIndex === null) continue
      issueLines.push(lineIndex)
      issuePositions.push({
        issueId: issue.id,
        lineIndex,
        reason: location.reason?.trim() || issue.description,
        markerIndex: location.marker_index,
      })
    }
    const uniqueLines = [...new Set(issueLines)].sort((a, b) => a - b)

    if (isGlobalIssue(issue, uniqueLines)) {
      globalIssues.push(issue)
      continue
    }

    anchoredIssues.push(issue)
    linesByIssue.set(issue.id, uniqueLines)
    for (const position of issuePositions) {
      const list = positionsByLine.get(position.lineIndex) ?? []
      // 同一 issue 在同一行的多处引用只保留一条（避免重复卡片）
      if (!list.some((item) => item.issueId === position.issueId && item.reason === position.reason)) {
        list.push(position)
      }
      positionsByLine.set(position.lineIndex, list)
    }
  }

  const sortBySeverity = (a: IssueGroup, b: IssueGroup) =>
    SEVERITY_ORDER.indexOf(a.severity_display) - SEVERITY_ORDER.indexOf(b.severity_display)
  globalIssues.sort(sortBySeverity)
  anchoredIssues.sort(sortBySeverity)

  return { lines, linesByIssue, positionsByLine, globalIssues, anchoredIssues }
}

function SummaryCard({
  issue,
  active,
  locatedLineCount,
  onSelect,
  onOpenIssue,
  isGlobal,
}: {
  issue: IssueGroup
  active: boolean
  locatedLineCount: number
  onSelect: () => void
  onOpenIssue: (issue: IssueGroup) => void
  isGlobal: boolean
}) {
  return (
    <article
      className={cn(
        'rounded-lg border bg-white transition',
        active ? 'border-sky-400 ring-2 ring-sky-100' : 'border-slate-200',
        issue.profile_conflict && !active ? 'border-violet-200' : '',
      )}
    >
      <button type="button" className="block w-full px-4 py-3 text-left" onClick={onSelect}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={severityBadge[issue.severity_display]}>{issue.severity_display}</Badge>
          <span className="text-sm font-semibold text-slate-950">{issue.title}</span>
          <Badge>{CATEGORY_LABELS[issue.category]}</Badge>
          <Badge>可信度 {issue.confidence_display}</Badge>
          {isGlobal ? (
            <Badge className="border-sky-200 bg-sky-50 text-sky-700">
              <Globe className="mr-1 h-3 w-3" />
              整体观察
            </Badge>
          ) : locatedLineCount > 0 ? (
            <Badge className={active ? 'border-sky-300 bg-sky-100 text-sky-800' : ''}>
              {active ? '已在下方标亮' : '点击查看位置'}
            </Badge>
          ) : null}
          {issue.profile_conflict ? (
            <Badge className="border-violet-200 bg-violet-50 text-violet-700">
              <AlertTriangle className="mr-1 h-3 w-3" />
              画像待核实
            </Badge>
          ) : null}
        </div>
        <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">{issue.description}</p>
      </button>
      <div className="border-t border-slate-100 px-4 py-2">
        <button
          type="button"
          className="text-xs text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-800"
          onClick={() => onOpenIssue(issue)}
        >
          查看完整证据与修复建议
        </button>
      </div>
    </article>
  )
}

export function AnnotatedDocument({ targetSp, issues, onOpenIssue }: AnnotatedDocumentProps) {
  const layout = useMemo(() => buildLayout(targetSp, issues), [targetSp, issues])
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null)
  const [expandedLine, setExpandedLine] = useState<number | null>(null)
  const documentRef = useRef<HTMLDivElement | null>(null)

  const activeLines = useMemo(() => {
    if (!activeIssueId) return new Set<number>()
    return new Set(layout.linesByIssue.get(activeIssueId) ?? [])
  }, [activeIssueId, layout])

  const selectIssue = (issue: IssueGroup) => {
    const next = activeIssueId === issue.id ? null : issue.id
    setActiveIssueId(next)
    setExpandedLine(null)
    if (next) {
      const firstLine = (layout.linesByIssue.get(issue.id) ?? [])[0]
      if (firstLine !== undefined) {
        // 滚动到该问题的第一个位置
        requestAnimationFrame(() => {
          documentRef.current
            ?.querySelector(`[data-line="${firstLine}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
      }
    }
  }

  return (
    <div className="space-y-4">
      {/* ============ 问题汇总区 ============ */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <ListOrdered className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">问题汇总</h2>
          <span className="text-xs text-slate-400">按严重程度排列 · 点击定位性问题可在下方原文中标亮位置</span>
        </div>

        {layout.globalIssues.length > 0 ? (
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-semibold text-slate-500">针对整份文档的观察</h3>
            <div className="space-y-2">
              {layout.globalIssues.map((issue) => (
                <SummaryCard
                  key={issue.id}
                  issue={issue}
                  active={false}
                  locatedLineCount={0}
                  onSelect={() => onOpenIssue(issue)}
                  onOpenIssue={onOpenIssue}
                  isGlobal
                />
              ))}
            </div>
          </div>
        ) : null}

        {layout.anchoredIssues.length > 0 ? (
          <div>
            {layout.globalIssues.length > 0 ? (
              <h3 className="mb-2 text-xs font-semibold text-slate-500">定位到具体位置的问题</h3>
            ) : null}
            <div className="space-y-2">
              {layout.anchoredIssues.map((issue) => (
                <SummaryCard
                  key={issue.id}
                  issue={issue}
                  active={activeIssueId === issue.id}
                  locatedLineCount={(layout.linesByIssue.get(issue.id) ?? []).length}
                  onSelect={() => selectIssue(issue)}
                  onOpenIssue={onOpenIssue}
                  isGlobal={false}
                />
              ))}
            </div>
          </div>
        ) : null}

        {layout.globalIssues.length === 0 && layout.anchoredIssues.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
            没有需要展示的问题
          </p>
        ) : null}
      </section>

      {/* ============ 原文铺开区 ============ */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <FileSearch className="h-4 w-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-950">原文与标记</h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            黄色为有问题的位置；在上方点击某个问题后，该问题涉及的所有位置会以蓝色标亮。点击任意标记行可展开这一处的具体原因。
          </p>
        </div>

        <div ref={documentRef} className="max-h-[70vh] overflow-y-auto px-2 py-3 font-mono text-xs leading-6">
          {layout.lines.map((line, index) => {
            const positions = layout.positionsByLine.get(index)
            const isActive = activeLines.has(index)
            const expanded = expandedLine === index
            if (!positions) {
              return (
                <div key={index} data-line={index} className="flex gap-3 px-3">
                  <span className="w-8 shrink-0 select-none text-right text-slate-300">{index + 1}</span>
                  <span className="whitespace-pre-wrap break-all text-slate-700">{line || ' '}</span>
                </div>
              )
            }
            const visiblePositions = expanded
              ? isActive
                ? positions.filter((position) => position.issueId === activeIssueId)
                : positions
              : []
            return (
              <div key={index} data-line={index}>
                <button
                  type="button"
                  onClick={() => setExpandedLine(expanded ? null : index)}
                  className={cn(
                    'flex w-full gap-3 rounded px-3 text-left transition',
                    isActive
                      ? 'bg-sky-200/80 hover:bg-sky-200'
                      : expanded
                        ? 'bg-amber-100'
                        : 'bg-amber-50 hover:bg-amber-100',
                  )}
                >
                  <span
                    className={cn(
                      'w-8 shrink-0 select-none text-right font-semibold',
                      isActive ? 'text-sky-700' : 'text-amber-600',
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-medium text-slate-900">
                    {line || ' '}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 pt-1">
                    {positions.slice(0, 6).map((position) => {
                      const issue = issues.find((item) => item.id === position.issueId)
                      return (
                        <span
                          key={`${position.issueId}-${position.markerIndex}`}
                          className={cn(
                            'h-2 w-2 rounded-full',
                            position.issueId === activeIssueId
                              ? 'ring-2 ring-sky-400 ring-offset-1'
                              : '',
                            severityDot[issue?.severity_display ?? '轻微'],
                          )}
                        />
                      )
                    })}
                    {expanded ? (
                      <ChevronDown className="h-3 w-3 text-slate-500" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-slate-500" />
                    )}
                  </span>
                </button>
                {expanded ? (
                  <div className="ml-11 mr-3 my-2 space-y-2 font-sans">
                    {visiblePositions.map((position) => {
                      const issue = issues.find((item) => item.id === position.issueId)
                      if (!issue) return null
                      return (
                        <button
                          key={`${position.issueId}-${position.markerIndex}`}
                          type="button"
                          onClick={() => onOpenIssue(issue)}
                          className={cn(
                            'block w-full rounded-md border bg-white px-3 py-2 text-left transition hover:bg-slate-50',
                            position.issueId === activeIssueId ? 'border-sky-300' : 'border-slate-200',
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn('h-2 w-2 rounded-full', severityDot[issue.severity_display])} />
                            <span className="text-xs font-semibold text-slate-900">{issue.title}</span>
                            <Badge>{CATEGORY_LABELS[issue.category]}</Badge>
                          </div>
                          <p className="mt-1 text-xs leading-5 text-slate-600">{position.reason}</p>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>

        <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          {layout.positionsByLine.size > 0
            ? `${layout.positionsByLine.size} 处原文位置有标记。`
            : '原文中没有定位到需要标记的位置。'}
          {layout.globalIssues.length > 0
            ? ` 另有 ${layout.globalIssues.length} 条针对整份文档的观察，见上方汇总区。`
            : ''}
        </div>
      </section>
    </div>
  )
}
