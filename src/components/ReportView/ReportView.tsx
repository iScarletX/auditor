import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileSearch,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type {
  IssueGroup,
  ReviewReport,
  SeverityDisplay,
} from '../../types/reviewReport.types'
import { calculateReviewScore } from '../../core/orchestrator/scoreCalculator'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { ScoreRadar } from './ScoreRadar'

interface ReportViewProps {
  report: ReviewReport
  targetSp: string
  scenarioHint: string
  onOpenIssue: (issue: IssueGroup) => void
  onExportJson: () => void
  onExportMarkdown: () => void
}

const NATURE_LABELS: Record<string, string> = {
  wording: '表述问题',
  flow: '流程设计',
  engineering: '工程实现',
  safety: '安全合规',
}

const NATURE_BADGE: Record<string, string> = {
  wording: 'border-sky-200 bg-sky-50 text-sky-700',
  flow: 'border-purple-200 bg-purple-50 text-purple-700',
  engineering: 'border-slate-300 bg-slate-100 text-slate-700',
  safety: 'border-red-200 bg-red-50 text-red-700',
}

const severityDot: Record<SeverityDisplay, string> = {
  严重: 'bg-red-500',
  中等: 'bg-amber-500',
  轻微: 'bg-slate-400',
}

const SEVERITY_RANK: Record<SeverityDisplay, number> = { 严重: 0, 中等: 1, 轻微: 2 }

function isConfirmedIssue(issue: IssueGroup) {
  return issue.confidence_display !== '仅供参考'
}

function normalizeCompact(value: string) {
  return value.replace(/\s+/g, '')
}

// ===== 定位工具 =====

interface Locator {
  lines: string[]
  locateProbe: (probe: string | null | undefined) => number | null
}

function makeLocator(targetSp: string): Locator {
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
  const locateProbe = (probe: string | null | undefined): number | null => {
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
  return { lines, locateProbe }
}

// ===== 大问题构建 =====

interface ProblemPosition {
  lineIndex: number
  reason: string
}

interface BigProblem {
  key: string
  actionPriority: number | null
  /** 列表行标题：问题现象本身(problem_statement)，不是改法 */
  title: string
  /** 详情页里“建议改法”部分(原 action_summary)，与 title 分开展示，不在列表行里重复 */
  actionSummary: string
  why: string
  nature?: string
  groupingLogic?: string
  positionRelation?: 'joint' | 'independent'
  severity: SeverityDisplay
  relatedIssues: IssueGroup[]
  positions: ProblemPosition[]
  /** 整体问题：无可靠具体定位（含全部锚在第1行的全文观察类）。自审问题B的防线。 */
  isGlobal: boolean
}

const GLOBAL_PRONE_TITLES = /长度|篇幅|Token|预算|风格一致|注入防御|任务边界|过度约束|角色定位|自检|模型能力|可移植|结构|冗余/i

function buildBigProblems(report: ReviewReport, locator: Locator) {
  const referenceIssues = report.issues.filter((issue) => !isConfirmedIssue(issue))
  const confirmed = report.issues.filter(isConfirmedIssue)

  // B2汇总阶段的LLM有时会对related_issue_ids里的id自行简化(比如把 group-05_xxx-yyy 简化成 group-05_xxx)，
  // 导致与issue.id字符串完全一致才能命中的精确匹配会静默丢失这条issue（实测已确证会导致“N处联合”与
  // 实际展示的位置数差很大）。加一层宽松包含关系兼容：若精确匹配失败，再尝试互相包含(只要
  // 一方是对方的完整字符串子串，不是巧合部分重合)。
  const findIssue = (id: string) =>
    report.issues.find(
      (issue) =>
        issue.id === id ||
        issue.locations.some((location) => location.source_issue_id === id) ||
        (id.length >= 8 && (issue.id.includes(id) || id.includes(issue.id))),
    )

  const issuePositions = (issue: IssueGroup): ProblemPosition[] => {
    const positions: ProblemPosition[] = []
    for (const location of issue.locations) {
      const lineIndex =
        locator.locateProbe(location.matched_text) ??
        locator.locateProbe(location.anchor_before) ??
        locator.locateProbe(location.anchor_after)
      if (lineIndex === null) continue
      if (positions.some((position) => position.lineIndex === lineIndex)) continue
      positions.push({ lineIndex, reason: location.reason?.trim() || issue.description })
    }
    return positions
  }

  const problems: BigProblem[] = []
  const coveredIssueIds = new Set<string>()
  const actions = [...report.prescription.priority_actions].sort((a, b) => a.priority - b.priority)

  for (const action of actions) {
    const related = action.related_issue_ids
      .map(findIssue)
      .filter((issue): issue is IssueGroup => Boolean(issue))
    related.forEach((issue) => coveredIssueIds.add(issue.id))
    const positions = related.flatMap(issuePositions)
    const uniqueLines = [...new Set(positions.map((position) => position.lineIndex))]
    // 自审问题B防线：全部位置都在第1行且属于全文观察类 → 整体问题，不占原文标记
    const isGlobal =
      uniqueLines.length === 0 ||
      (uniqueLines.every((line) => line === 0) && GLOBAL_PRONE_TITLES.test(action.action_summary))
    const confirmedRelated = related.filter(isConfirmedIssue)
    const severity: SeverityDisplay =
      confirmedRelated.length > 0
        ? confirmedRelated.reduce<SeverityDisplay>(
            (acc, issue) => (SEVERITY_RANK[issue.severity_display] < SEVERITY_RANK[acc] ? issue.severity_display : acc),
            '轻微',
          )
        : '中等'
    problems.push({
      key: `action-${action.priority}`,
      actionPriority: action.priority,
      title: action.problem_statement,
      actionSummary: action.action_summary,
      why: action.why,
      nature: action.nature,
      groupingLogic: action.grouping_logic,
      positionRelation: action.position_relation,
      severity,
      relatedIssues: related,
      positions: isGlobal ? [] : positions,
      isGlobal,
    })
  }

  // 兜底：确认 issue 未被任何大问题覆盖 → 独立成条，不静默丢失
  for (const issue of confirmed) {
    if (coveredIssueIds.has(issue.id)) continue
    const positions = issuePositions(issue)
    const uniqueLines = [...new Set(positions.map((position) => position.lineIndex))]
    const isGlobal =
      uniqueLines.length === 0 ||
      (uniqueLines.every((line) => line === 0) && GLOBAL_PRONE_TITLES.test(issue.title))
    problems.push({
      key: `uncovered-${issue.id}`,
      actionPriority: null,
      // 兼底条没有经过B2汇总，本身issue.title就是具体发现，直接当现象标题用；actionSummary无来源且本身就是未经整理的单条发现，不需额外提供改法说明
      title: issue.title,
      actionSummary: '',
      why: issue.description.split('\n')[0],
      severity: issue.severity_display,
      relatedIssues: [issue],
      positions: isGlobal ? [] : positions,
      isGlobal,
    })
  }

  problems.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  return { problems, referenceIssues }
}

// ===== 修复应用状态 =====

type EditState = 'pending' | 'applied' | 'ignored'

interface EditRuntime {
  state: EditState
  /** 用户编辑后的替换文本（默认 = 模型建议的 after_text） */
  effectiveAfter: string
}

// ===== 大问题列表行（必改区/次要区复用） =====

function ProblemRow({ problem, onClick }: { problem: BigProblem; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition hover:bg-slate-50"
      onClick={onClick}
    >
      <span className={cn('h-3 w-3 shrink-0 rounded-full', severityDot[problem.severity])} />
      <span className="min-w-0 flex-1">
        <span className="text-sm font-medium text-slate-950">{problem.title}</span>
        <span className="ml-2 inline-flex flex-wrap items-center gap-1.5 align-middle">
          {problem.nature ? (
            <Badge className={NATURE_BADGE[problem.nature]}>{NATURE_LABELS[problem.nature]}</Badge>
          ) : null}
          <span className="text-xs text-slate-500">
            {problem.isGlobal
              ? '整体问题'
              : problem.positionRelation === 'joint'
                ? `${problem.positions.length} 处联合`
                : `${problem.positions.length} 处位置`}
          </span>
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
    </button>
  )
}

// ===== 详情弹窗 =====

function ProblemDetail({
  problem,
  report,
  locator,
  workingSp,
  editRuntimes,
  onApplyEdit,
  onIgnoreEdit,
  onRevertEdit,
  onEditText,
  onClose,
  onOpenIssue,
}: {
  problem: BigProblem
  report: ReviewReport
  locator: Locator
  workingSp: string
  editRuntimes: Map<string, EditRuntime>
  onApplyEdit: (editKeys: string[]) => void
  onIgnoreEdit: (editKey: string) => void
  onRevertEdit: (editKeys: string[]) => void
  onEditText: (editKey: string, text: string) => void
  onClose: () => void
  onOpenIssue: (issue: IssueGroup) => void
}) {
  const [expandedLine, setExpandedLine] = useState<number | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [showRawData, setShowRawData] = useState(false)
  const [showMeta, setShowMeta] = useState(false)

  const fixPlan = problem.actionPriority !== null
    ? (report.fix_plans ?? []).find((plan) => plan.action_priority === problem.actionPriority)
    : undefined
  const isGroupFix = fixPlan?.apply_mode === 'group'
  const editKey = (index: number) => `${problem.actionPriority}-${index}`
  const groupEditKeys = fixPlan ? fixPlan.edits.map((_, index) => editKey(index)) : []
  const groupState: EditState = groupEditKeys.length > 0
    ? (editRuntimes.get(groupEditKeys[0])?.state ?? 'pending')
    : 'pending'

  const positionLines = useMemo(
    () => new Map(problem.positions.map((position) => [position.lineIndex, position])),
    [problem],
  )
  const otherLinesLabel = (current: number) =>
    problem.positions
      .filter((position) => position.lineIndex !== current)
      .map((position) => `第 ${position.lineIndex + 1} 行`)
      .join('、')

  const editLocatableNow = (beforeText: string) => {
    const trimmed = beforeText.trim()
    if (!trimmed) return false
    if (workingSp.includes(trimmed)) return true
    if (trimmed.length >= 8) return normalizeCompact(workingSp).includes(normalizeCompact(trimmed))
    return false
  }

  const renderEditCard = (edit: { before_text: string; after_text: string; note: string }, index: number) => {
    const key = editKey(index)
    const runtime = editRuntimes.get(key) ?? { state: 'pending' as EditState, effectiveAfter: edit.after_text }
    const locatable = runtime.state === 'applied' || editLocatableNow(edit.before_text)
    const editing = editingKey === key
    return (
      <div key={key} className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs leading-5 text-slate-600">{edit.note}</p>
        <div className="mt-2 space-y-1.5 font-mono text-xs">
          <div className="rounded bg-red-50 px-2 py-1.5 text-red-800 line-through decoration-red-300">
            {edit.before_text}
          </div>
          {editing ? (
            <textarea
              className="w-full rounded border border-emerald-300 bg-white px-2 py-1.5 font-mono text-xs leading-5 text-emerald-900 outline-none focus:ring-2 focus:ring-emerald-200"
              rows={3}
              value={runtime.effectiveAfter}
              onChange={(event) => onEditText(key, event.target.value)}
            />
          ) : (
            <div className="rounded bg-emerald-50 px-2 py-1.5 text-emerald-800">{runtime.effectiveAfter}</div>
          )}
        </div>
        {!isGroupFix ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {runtime.state === 'applied' ? (
              <>
                <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">
                  <Check className="mr-1 h-3 w-3" />
                  已应用
                </Badge>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-slate-500 underline decoration-dotted underline-offset-2"
                  onClick={() => onRevertEdit([key])}
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
                  onClick={() => onRevertEdit([key])}
                >
                  恢复
                </button>
              </>
            ) : (
              <>
                <Button size="sm" onClick={() => { setEditingKey(null); onApplyEdit([key]) }} disabled={!locatable}>
                  <Check className="h-3.5 w-3.5" />
                  应用这一处
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditingKey(editing ? null : key)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {editing ? '完成编辑' : '编辑后应用'}
                </Button>
                <button
                  type="button"
                  className="text-xs text-slate-500 underline decoration-dotted underline-offset-2"
                  onClick={() => onIgnoreEdit(key)}
                >
                  忽略
                </button>
                {!locatable ? (
                  <span className="text-xs text-amber-700">原文已变化，无法自动应用，请手动处理</span>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="overflow-y-auto">
          {/* 问题说明：第一眼必须看到完整现象(problem.title现已要求包含现象+影响+后果三层)，其他元信息全部收进折叠区 */}
          <div className="border-b border-slate-200 px-6 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('h-3 w-3 rounded-full', severityDot[problem.severity])} />
                  {problem.nature ? (
                    <Badge className={NATURE_BADGE[problem.nature]}>{NATURE_LABELS[problem.nature]}</Badge>
                  ) : null}
                  {problem.isGlobal ? (
                    <Badge>整体问题</Badge>
                  ) : problem.positionRelation ? (
                    <Badge>
                      {problem.positionRelation === 'joint'
                        ? `${problem.positions.length} 处联合构成`
                        : `${problem.positions.length} 处独立`}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-2 text-base leading-7 text-slate-900">{problem.title}</p>
              </div>
              <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={onClose}>
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* 应对思路：看完现象后紧接的“所以建议怎么改”，保留在主体信息里(不归入折叠)，因为这是用户真正关心的行动建议 */}
          {problem.actionSummary ? (
            <div className="border-b border-slate-200 px-6 py-4">
              <p className="text-sm leading-6 text-slate-800">
                <span className="font-medium text-slate-950">应对思路：</span>
                {problem.actionSummary}
              </p>
            </div>
          ) : null}

          {/* 折叠的补充信息：为什么这几处合并+优先处理理由，都是“元信息”，默认收起，不抢占阅读第一视觉焦点 */}
          {problem.groupingLogic || problem.why ? (
            <div className="border-b border-slate-100 px-6 py-2.5">
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
                onClick={() => setShowMeta((value) => !value)}
              >
                {showMeta ? '收起' : '查看'}判定依据
                {showMeta ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              {showMeta ? (
                <div className="mt-2 space-y-1.5">
                  {problem.groupingLogic ? (
                    <p className="rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                      <span className="font-medium text-slate-700">为什么这几处是同一个问题：</span>
                      {problem.groupingLogic}
                    </p>
                  ) : null}
                  {problem.why ? <p className="text-xs leading-5 text-slate-500">{problem.why}</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* 修复方案 */}
          {fixPlan ? (
            <div className="border-b border-slate-200 px-6 py-4">
              <h3 className="text-sm font-semibold text-slate-950">
                具体修改
                {isGroupFix ? (
                  <span className="ml-2 text-xs font-normal text-purple-700">
                    以下 {fixPlan.edits.length} 处必须作为一组应用
                  </span>
                ) : null}
              </h3>
              {isGroupFix && fixPlan.group_note ? (
                <p className="mt-1 rounded-md bg-purple-50 px-3 py-2 text-xs leading-5 text-purple-800">
                  {fixPlan.group_note}
                </p>
              ) : null}
              {fixPlan.confidence_caveat ? (
                <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  这个问题仅由单个模型提出（未获得交叉确认），下方修法仅供参考，建议人工复核后再应用。
                </p>
              ) : null}
              {fixPlan.edits.length === 0 ? (
                <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">
                  {fixPlan.no_fix_reason ?? '此问题需要业务决策，无法给出文字级修复。'}
                </p>
              ) : (
                <div className="mt-2 space-y-2">{fixPlan.edits.map(renderEditCard)}</div>
              )}
              {isGroupFix && fixPlan.edits.length > 0 ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {groupState === 'applied' ? (
                    <>
                      <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">
                        <Check className="mr-1 h-3 w-3" />
                        整组已应用
                      </Badge>
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-slate-500 underline decoration-dotted underline-offset-2"
                        onClick={() => onRevertEdit(groupEditKeys)}
                      >
                        <RotateCcw className="h-3 w-3" />
                        撤销整组
                      </button>
                    </>
                  ) : groupState === 'ignored' ? (
                    <>
                      <Badge>整组已忽略</Badge>
                      <button
                        type="button"
                        className="text-xs text-slate-500 underline decoration-dotted underline-offset-2"
                        onClick={() => onRevertEdit(groupEditKeys)}
                      >
                        恢复
                      </button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        onClick={() => onApplyEdit(groupEditKeys)}
                        disabled={!fixPlan.edits.every((edit) => editLocatableNow(edit.before_text))}
                      >
                        <Check className="h-3.5 w-3.5" />
                        应用整组修改
                      </Button>
                      <button
                        type="button"
                        className="text-xs text-slate-500 underline decoration-dotted underline-offset-2"
                        onClick={() => groupEditKeys.forEach((key) => onIgnoreEdit(key))}
                      >
                        忽略整组
                      </button>
                      {!fixPlan.edits.every((edit) => editLocatableNow(edit.before_text)) ? (
                        <span className="text-xs text-amber-700">部分原文已变化，无法整组应用</span>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* 原文（只标本问题位置） */}
          <div className="px-2 py-3 font-mono text-xs leading-6">
            {problem.isGlobal ? (
              <p className="px-4 py-4 text-center font-sans text-sm text-slate-500">
                这个问题针对文档整体，没有绑定到具体某一行。
              </p>
            ) : (
              locator.lines.map((line, index) => {
                const position = positionLines.get(index)
                const expanded = expandedLine === index
                if (!position) {
                  return (
                    <div key={index} className="flex gap-3 px-3">
                      <span className="w-8 shrink-0 select-none text-right text-slate-300">{index + 1}</span>
                      <span className="whitespace-pre-wrap break-all text-slate-600">{line || ' '}</span>
                    </div>
                  )
                }
                return (
                  <div key={index}>
                    <button
                      type="button"
                      onClick={() => setExpandedLine(expanded ? null : index)}
                      className={cn(
                        'flex w-full gap-3 rounded px-3 text-left transition',
                        expanded ? 'bg-red-100' : 'bg-red-50 hover:bg-red-100',
                      )}
                    >
                      <span className="w-8 shrink-0 select-none text-right font-semibold text-red-500">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-medium text-slate-900">
                        {line || ' '}
                      </span>
                      {expanded ? (
                        <ChevronDown className="mt-1 h-3 w-3 shrink-0 text-slate-500" />
                      ) : (
                        <ChevronRight className="mt-1 h-3 w-3 shrink-0 text-slate-500" />
                      )}
                    </button>
                    {expanded ? (
                      <div className="ml-11 mr-3 my-2 rounded-md border border-red-200 bg-white px-3 py-2.5 font-sans">
                        {problem.positionRelation === 'joint' ? (
                          <p className="mb-1.5 text-xs font-medium text-red-700">
                            这一处与{otherLinesLabel(index) || '其他位置'}联合构成本问题：
                          </p>
                        ) : null}
                        <p className="whitespace-pre-line text-xs leading-5 text-slate-700">{position.reason}</p>
                      </div>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>

          {/* 原始检测数据入口（自审：砍掉侧滑面板后保留的核查通道） */}
          <div className="border-t border-slate-100 px-6 py-3">
            <button
              type="button"
              className="text-xs text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-700"
              onClick={() => setShowRawData((value) => !value)}
            >
              {showRawData ? '收起' : '查看'}原始检测数据（{problem.relatedIssues.length} 条记录）
            </button>
            {showRawData ? (
              <div className="mt-2 space-y-2">
                {problem.relatedIssues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    className="block w-full rounded border border-slate-200 px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
                    onClick={() => onOpenIssue(issue)}
                  >
                    <span className="font-medium text-slate-800">{issue.title}</span>
                    <span className="ml-2">可信度 {issue.confidence_display} · {issue.severity_display}</span>
                    <span className="mt-1 block line-clamp-2">{issue.description}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

// ===== 主报告 =====

export function ReportView({
  report,
  targetSp,
  scenarioHint,
  onOpenIssue,
  onExportJson,
  onExportMarkdown,
}: ReportViewProps) {
  const locator = useMemo(() => makeLocator(targetSp), [targetSp])
  const { problems, referenceIssues } = useMemo(() => buildBigProblems(report, locator), [report, locator])
  const score = useMemo(
    () =>
      calculateReviewScore({
        issues: report.issues,
        checkPlan: report.check_plan ?? [],
        documentProfile: report.document_profile,
        scenarioHint,
        targetSp,
        fallbackSkillsRun: report.meta.skills_run,
      }),
    [report, scenarioHint, targetSp],
  )

  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [showReference, setShowReference] = useState(false)
  const [showFullDoc, setShowFullDoc] = useState(false)
  const [showScoreDetail, setShowScoreDetail] = useState(false)
  const [showMinorNotes, setShowMinorNotes] = useState(false)
  const [showSecondaryProblems, setShowSecondaryProblems] = useState(false)
  const [expandedDocLine, setExpandedDocLine] = useState<number | null>(null)

  // 修复应用状态：workingSp 是应用修改后的工作副本
  const [workingSp, setWorkingSp] = useState(targetSp)
  const [editRuntimes, setEditRuntimes] = useState<Map<string, EditRuntime>>(new Map())
  const appliedCount = [...editRuntimes.values()].filter((runtime) => runtime.state === 'applied').length

  const findEdit = (key: string) => {
    const [priorityStr, indexStr] = key.split('-')
    const plan = (report.fix_plans ?? []).find((item) => item.action_priority === Number(priorityStr))
    return plan?.edits[Number(indexStr)]
  }

  const applyEdits = (keys: string[]) => {
    setWorkingSp((current) => {
      let next = current
      for (const key of keys) {
        const edit = findEdit(key)
        if (!edit) continue
        const runtime = editRuntimes.get(key)
        const after = runtime?.effectiveAfter ?? edit.after_text
        if (next.includes(edit.before_text)) {
          next = next.replace(edit.before_text, after)
        }
      }
      return next
    })
    setEditRuntimes((current) => {
      const next = new Map(current)
      for (const key of keys) {
        const edit = findEdit(key)
        if (!edit) continue
        const existing = next.get(key)
        next.set(key, { state: 'applied', effectiveAfter: existing?.effectiveAfter ?? edit.after_text })
      }
      return next
    })
  }

  const revertEdits = (keys: string[]) => {
    setWorkingSp((current) => {
      let next = current
      for (const key of keys) {
        const edit = findEdit(key)
        if (!edit) continue
        const runtime = editRuntimes.get(key)
        const after = runtime?.effectiveAfter ?? edit.after_text
        if (runtime?.state === 'applied' && next.includes(after)) {
          next = next.replace(after, edit.before_text)
        }
      }
      return next
    })
    setEditRuntimes((current) => {
      const next = new Map(current)
      for (const key of keys) {
        const edit = findEdit(key)
        if (!edit) continue
        next.set(key, { state: 'pending', effectiveAfter: next.get(key)?.effectiveAfter ?? edit.after_text })
      }
      return next
    })
  }

  const ignoreEdit = (key: string) => {
    const edit = findEdit(key)
    if (!edit) return
    setEditRuntimes((current) => {
      const next = new Map(current)
      next.set(key, { state: 'ignored', effectiveAfter: next.get(key)?.effectiveAfter ?? edit.after_text })
      return next
    })
  }

  const editText = (key: string, text: string) => {
    const edit = findEdit(key)
    if (!edit) return
    setEditRuntimes((current) => {
      const next = new Map(current)
      const existing = next.get(key)
      next.set(key, { state: existing?.state ?? 'pending', effectiveAfter: text })
      return next
    })
  }

  const exportModifiedSp = () => {
    const blob = new Blob([workingSp], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'prompt-修改后.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const profile = report.document_profile
  const checkPlan = report.check_plan ?? []
  const ranCheckCount = checkPlan.filter((entry) => entry.decision === 'run').length || report.meta.skills_run.length
  const detailProblem = problems.find((problem) => problem.key === detailKey) ?? null
  const minorNotes = report.prescription.minor_notes

  // ⑦ 倒金字塔·必修上限铁律：严重/中等进「必改区」（上限 7 条，SP 类），
  // 轻微 + 超出上限的中等问题进「次要区」折叠，让用户先聚焦非改不可的那几条。
  const MUST_FIX_LIMIT = 7
  const { mustFixProblems, secondaryProblems } = useMemo(() => {
    const mustFix: BigProblem[] = []
    const secondary: BigProblem[] = []
    for (const problem of problems) {
      const isCritical = problem.severity === '严重' || problem.severity === '中等'
      if (isCritical && mustFix.length < MUST_FIX_LIMIT) {
        mustFix.push(problem)
      } else {
        secondary.push(problem)
      }
    }
    return { mustFixProblems: mustFix, secondaryProblems: secondary }
  }, [problems])

  // 完整原文区：全部大问题位置合并
  const docPositions = useMemo(() => {
    const map = new Map<number, Array<{ problem: BigProblem; reason: string }>>()
    for (const problem of problems) {
      for (const position of problem.positions) {
        const list = map.get(position.lineIndex) ?? []
        if (!list.some((item) => item.problem.key === problem.key)) {
          list.push({ problem, reason: position.reason })
        }
        map.set(position.lineIndex, list)
      }
    }
    return map
  }, [problems])

  return (
    <div className="space-y-4">
      {report.incomplete_checks.length > 0 ? (
        <section className="rounded-lg border border-red-200 bg-red-50 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
            <div>
              <h2 className="text-sm font-semibold text-red-950">本次报告可能不完整</h2>
              <p className="mt-1 text-sm leading-6 text-red-800">
                以下检查未获得任何模型结果：{report.incomplete_checks.map((check) => check.skill_title).join('、')}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* 体检卡：一句话理解 + 得分 + 雷达 */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <p className="text-base font-semibold leading-7 text-slate-950">{profile.document_purpose}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>输出给：{profile.output_consumer}</span>
              <span>
                {ranCheckCount} 项检查 · {report.meta.models_used.length} 个模型交叉验证
              </span>
              <span className="text-slate-400">理解有偏差？在左侧"补充说明"中纠正后重新审查</span>
            </div>
            {score.strengths.length > 0 ? (
              <p className="mt-3 text-sm leading-6 text-slate-700">
                <span className="font-medium text-emerald-700">做得好：</span>
                {score.strengths.join('、')}
              </p>
            ) : null}
            {score.weaknesses.length > 0 ? (
              <p className="mt-1 text-sm leading-6 text-slate-700">
                <span className="font-medium text-amber-700">待改进：</span>
                {score.weaknesses.join('、')}
              </p>
            ) : null}
            <button
              type="button"
              className="mt-3 flex items-center gap-1 text-xs text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-700"
              onClick={() => setShowScoreDetail((value) => !value)}
            >
              计分依据
              {showScoreDetail ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
            {showScoreDetail ? (
              <div className="mt-2 space-y-1.5 text-xs leading-5 text-slate-600">
                <p className="text-slate-500">
                  只按多模型确认的问题扣分；"未检"维度不参与总分；权重由文档特征决定：
                </p>
                {score.dimensions.map((dim) => (
                  <div key={dim.key}>
                    <span className="font-medium text-slate-800">{dim.label}</span>
                    {dim.score === null ? (
                      <span>：未检（该维度检查项本次全部不适用）</span>
                    ) : (
                      <span>
                        ：{dim.score} 分 · 权重 {dim.weight}（{dim.weightReason}）
                        {dim.ranCheckCount < dim.totalCheckCount
                          ? ` · 检查了 ${dim.ranCheckCount}/${dim.totalCheckCount} 项`
                          : ''}
                        {dim.deductions.length > 0
                          ? ` · 扣分：${dim.deductions.map((item) => `${item.title}(-${item.penalty})`).join('、')}`
                          : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex flex-col items-center justify-center">
            <div className="text-center">
              <span className="text-5xl font-bold text-slate-950">{score.total}</span>
              <span className="ml-1 text-sm text-slate-400">/ 100</span>
            </div>
            <ScoreRadar dimensions={score.dimensions} />
          </div>
        </div>
      </section>

      {/* 结论 + 大问题列表（⑦ 倒金字塔：必改区在前、次要区折叠） */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <p className="text-sm leading-6 text-slate-700">{report.prescription.overall_assessment}</p>

        {problems.length === 0 ? (
          <p className="mt-4 rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
            没有需要处理的问题
          </p>
        ) : (
          <>
            {/* 必改区：非改不可的前 N 条 */}
            {mustFixProblems.length > 0 ? (
              <div className="mt-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700">
                    • 建议优先处理 {mustFixProblems.length} 处
                  </span>
                  <span className="text-xs text-slate-400">按严重程度排序，先看这几条</span>
                </div>
                <div className="space-y-1">
                  {mustFixProblems.map((problem) => (
                    <ProblemRow key={problem.key} problem={problem} onClick={() => setDetailKey(problem.key)} />
                  ))}
                </div>
              </div>
            ) : null}

            {/* 次要区：轻微 + 超出上限的问题，默认折叠 */}
            {secondaryProblems.length > 0 ? (
              <div className={cn('border-t border-slate-100', mustFixProblems.length > 0 ? 'mt-3 pt-3' : 'mt-4')}>
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
                  onClick={() => setShowSecondaryProblems((value) => !value)}
                >
                  其他 {secondaryProblems.length} 处次要问题（可选改）
                  {showSecondaryProblems ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                {showSecondaryProblems ? (
                  <div className="mt-2 space-y-1">
                    {secondaryProblems.map((problem) => (
                      <ProblemRow key={problem.key} problem={problem} onClick={() => setDetailKey(problem.key)} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        {minorNotes.length > 0 ? (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-700"
              onClick={() => setShowMinorNotes((value) => !value)}
            >
              {minorNotes.length} 条次要建议
              {showMinorNotes ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
            {showMinorNotes ? (
              <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
                {minorNotes.map((note) => (
                  <li key={note}>· {note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 完整原文（默认折叠） */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-5 py-3 text-left"
          onClick={() => setShowFullDoc((value) => !value)}
        >
          <FileSearch className="h-4 w-4 text-slate-500" />
          <span className="flex-1 text-sm font-semibold text-slate-950">
            完整原文
            <span className="ml-2 text-xs font-normal text-slate-400">
              {docPositions.size} 处标记 · 展开后可连贯通读，点击红色行查看该处原因
            </span>
          </span>
          {showFullDoc ? (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400" />
          )}
        </button>
        {showFullDoc ? (
          <div className="max-h-[70vh] overflow-y-auto border-t border-slate-100 px-2 py-3 font-mono text-xs leading-6">
            {locator.lines.map((line, index) => {
              const items = docPositions.get(index)
              const expanded = expandedDocLine === index
              if (!items) {
                return (
                  <div key={index} className="flex gap-3 px-3">
                    <span className="w-8 shrink-0 select-none text-right text-slate-300">{index + 1}</span>
                    <span className="whitespace-pre-wrap break-all text-slate-700">{line || ' '}</span>
                  </div>
                )
              }
              return (
                <div key={index}>
                  <button
                    type="button"
                    onClick={() => setExpandedDocLine(expanded ? null : index)}
                    className={cn(
                      'flex w-full gap-3 rounded px-3 text-left transition',
                      expanded ? 'bg-red-100' : 'bg-red-50 hover:bg-red-100',
                    )}
                  >
                    <span className="w-8 shrink-0 select-none text-right font-semibold text-red-500">{index + 1}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-medium text-slate-900">
                      {line || ' '}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 pt-1">
                      {items.slice(0, 4).map(({ problem }) => (
                        <span key={problem.key} className={cn('h-2 w-2 rounded-full', severityDot[problem.severity])} />
                      ))}
                      {expanded ? (
                        <ChevronDown className="h-3 w-3 text-slate-500" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-slate-500" />
                      )}
                    </span>
                  </button>
                  {expanded ? (
                    <div className="ml-11 mr-3 my-2 space-y-2 font-sans">
                      {items.map(({ problem, reason }) => (
                        <div key={problem.key} className="rounded-md border border-slate-200 bg-white px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn('h-2 w-2 rounded-full', severityDot[problem.severity])} />
                            <span className="text-xs font-semibold text-slate-900">{problem.title}</span>
                            {problem.nature ? (
                              <Badge className={NATURE_BADGE[problem.nature]}>{NATURE_LABELS[problem.nature]}</Badge>
                            ) : null}
                          </div>
                          <p className="mt-1.5 whitespace-pre-line text-xs leading-5 text-slate-700">{reason}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : null}
      </section>

      {/* 单模型参考区 */}
      {referenceIssues.length > 0 ? (
        <section className="rounded-lg border border-slate-200 bg-slate-50">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-5 py-3 text-left"
            onClick={() => setShowReference((value) => !value)}
          >
            <span className="flex-1 text-xs text-slate-500">
              另有 {referenceIssues.length} 条仅单个模型提出的意见（未获多模型确认，仅供参考）
            </span>
            {showReference ? (
              <ChevronDown className="h-4 w-4 text-slate-400" />
            ) : (
              <ChevronRight className="h-4 w-4 text-slate-400" />
            )}
          </button>
          {showReference ? (
            <div className="space-y-1 border-t border-slate-200 px-5 py-3">
              {referenceIssues.map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white"
                  onClick={() => onOpenIssue(issue)}
                >
                  <span
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0 rounded-full opacity-50',
                      severityDot[issue.severity_display],
                    )}
                  />
                  <span className="min-w-0">
                    <span className="text-xs font-medium text-slate-700">{issue.title}</span>
                    <span className="ml-2 text-xs text-slate-500">
                      {issue.description.split('\n')[0].slice(0, 80)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* 导出 */}
      <section className="grid gap-2 md:grid-cols-3">
        <Button type="button" variant={appliedCount > 0 ? 'primary' : 'secondary'} onClick={exportModifiedSp} disabled={appliedCount === 0}>
          <Download className="h-4 w-4" />
          导出修改后的 Prompt{appliedCount > 0 ? `（已应用 ${appliedCount} 处）` : ''}
        </Button>
        <Button type="button" variant="secondary" onClick={onExportJson}>
          <Download className="h-4 w-4" />
          导出完整数据（JSON）
        </Button>
        <Button type="button" variant="secondary" onClick={onExportMarkdown}>
          <Download className="h-4 w-4" />
          导出可读报告（Markdown）
        </Button>
      </section>

      {detailProblem ? (
        <ProblemDetail
          key={detailProblem.key}
          problem={detailProblem}
          report={report}
          locator={locator}
          workingSp={workingSp}
          editRuntimes={editRuntimes}
          onApplyEdit={applyEdits}
          onIgnoreEdit={ignoreEdit}
          onRevertEdit={revertEdits}
          onEditText={editText}
          onClose={() => setDetailKey(null)}
          onOpenIssue={onOpenIssue}
        />
      ) : null}
    </div>
  )
}
