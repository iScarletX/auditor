import { AlertTriangle, Check, X } from 'lucide-react'
import type { IssueGroup, IssueGroupLocation, RawModelOutput } from '../../types/reviewReport.types'
import { DiffMarker } from '../DiffMarker/DiffMarker'
import { Button } from '../ui/Button'

interface IssueDetailPanelProps {
  issue: IssueGroup | null
  targetSp: string
  rawModelOutputs: RawModelOutput[]
  onPreviewFix: (issue: IssueGroup, markerIndex: number) => void
  onPreviewAllFixes: (issue: IssueGroup) => void
  onClose: () => void
}

function markerLabel(index: number) {
  return ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'][index - 1] ?? `#${index}`
}

function findLocation(text: string, location: IssueGroupLocation) {
  const probe = location.matched_text
  if (probe) {
    const index = text.indexOf(probe)
    if (index >= 0) return { start: index, end: index + probe.length }
  }

  const beforeIndex = location.anchor_before ? text.indexOf(location.anchor_before) : -1
  if (beforeIndex >= 0) {
    const start = beforeIndex + location.anchor_before.length
    const afterIndex = location.anchor_after ? text.indexOf(location.anchor_after, start) : start
    if (afterIndex >= start) return { start, end: afterIndex }
  }

  return null
}

function buildSegments(text: string, locations: IssueGroupLocation[]) {
  const ranges = locations
    .map((location) => {
      const found = findLocation(text, location)
      return found ? { ...found, location } : null
    })
    .filter((item): item is { start: number; end: number; location: IssueGroupLocation } => Boolean(item))
    .sort((a, b) => a.start - b.start)

  const segments: Array<{ text: string; location?: IssueGroupLocation }> = []
  let cursor = 0
  ranges.forEach((range) => {
    if (range.start < cursor) return
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start) })
    segments.push({
      text: text.slice(range.start, Math.max(range.end, range.start + 1)) || range.location.matched_text || ' ',
      location: range.location,
    })
    cursor = Math.max(range.end, range.start + 1)
  })
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}

export function IssueDetailPanel({
  issue,
  targetSp,
  rawModelOutputs,
  onPreviewFix,
  onPreviewAllFixes,
  onClose,
}: IssueDetailPanelProps) {
  if (!issue) return null
  const segments = buildSegments(targetSp, issue.locations)
  const fixesByMarker = new Map(issue.fix_items.map((item) => [item.marker_index, item]))
  const rawOutputIds = new Set(issue.raw_model_output_ids ?? [])
  const relatedSkillIds = new Set(issue.related_skill_ids)
  const linkedRawOutputs = rawModelOutputs.filter((output) =>
    rawOutputIds.has(output.id) ||
    (output.phase === 'skill_check' && typeof output.skill_id === 'string' && relatedSkillIds.has(output.skill_id)),
  )
  const applicableFixCount = issue.locations.filter((location) => {
    const fix = fixesByMarker.get(location.marker_index)?.fix
    return Boolean(fix) && !location.ambiguous
  }).length

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/40">
      <aside className="flex h-full w-full max-w-4xl flex-col bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-950">{issue.title}</h2>
            <p className="mt-1 text-sm text-slate-600">{issue.description}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {issue.profile_conflict ? (
            <section className="mb-4 flex items-start gap-3 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-violet-700" />
              <div>
                <h3 className="text-sm font-semibold text-violet-950">此判断与文档画像存在矛盾</h3>
                <p className="mt-1 text-xs leading-5 text-violet-800">
                  {issue.profile_conflict_detail ?? '建议先核实文档画像，再决定是否采纳这一条判断。'}
                </p>
              </div>
            </section>
          ) : null}

          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-950">原文定位</h3>
            <pre className="whitespace-pre-wrap rounded-md bg-white p-4 font-mono text-xs leading-6 text-slate-800">
              {segments.map((segment, index) =>
                segment.location ? (
                  <DiffMarker key={`${segment.location.marker_index}-${index}`} label={markerLabel(segment.location.marker_index)}>
                    {segment.text}
                  </DiffMarker>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </pre>
          </section>

          {linkedRawOutputs.length > 0 ? (
            <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
              <details>
                <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
                  查看原始模型输出
                </summary>
                <div className="mt-3 space-y-3">
                  {linkedRawOutputs.map((output) => (
                    <div key={output.id} className="rounded-md border border-slate-200 bg-slate-950">
                      <div className="border-b border-slate-800 px-3 py-2 text-[11px] text-slate-300">
                        {output.model_id} · {output.schema_name} · attempt {output.attempt}
                      </div>
                      <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-5 text-slate-100">
                        {output.raw_response_text}
                      </pre>
                    </div>
                  ))}
                </div>
              </details>
            </section>
          ) : null}

          <section className="mt-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-950">修改建议</h3>
            {issue.locations.map((location) => {
              const fixItem = fixesByMarker.get(location.marker_index)
              const fix = fixItem?.fix ?? null
              return (
                <div key={location.marker_index} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-slate-950">
                      {markerLabel(location.marker_index)} 标记点
                    </div>
                    {location.ambiguous ? (
                      <span className="flex items-center gap-1 text-xs text-amber-700">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        需要手动确认位置
                      </span>
                    ) : null}
                  </div>
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-900">
                    {fix
                      ? fix.content ?? String(fix.to ?? fix.target ?? '查看差异预览确认修改')
                      : '这一处没有可直接应用的结构化修改，需要人工重写。'}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!fix || location.ambiguous}
                      onClick={() => onPreviewFix(issue, location.marker_index)}
                    >
                      <Check className="h-4 w-4" />
                      确认应用
                    </Button>
                  </div>
                </div>
              )
            })}
          </section>
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200 px-5 py-4">
          <div className="text-xs text-slate-500">
            可直接应用 {applicableFixCount} 处；位置不明确的标记点需要手动处理。
          </div>
          <Button
            type="button"
            disabled={applicableFixCount === 0}
            onClick={() => onPreviewAllFixes(issue)}
          >
            全部应用
          </Button>
        </footer>
      </aside>
    </div>
  )
}
