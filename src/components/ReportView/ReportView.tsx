import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileSearch,
  Pencil,
  X,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
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
  /** 打开整体修改工作台(点击时才按需生成修复方案，不在审查流程里自动跑) */
  onOpenFixWorkbench: () => void
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

// ===== 大问题列表行（必改区/次要区复用） =====

/**
 * 列表行只需要一个简短标题，完整三层描述(现象+原因+后果)留在详情页。
 * 不新增字段让LLM另外生成短标题(避免引入新的生成质量不确定性)，而是前端根据现有problem_statement
 * 取首句(遇到。！？就截断)，过长再按字数截断加省略号。
 */
function shortTitleOf(title: string): string {
  const firstSentence = title.split(/(?<=[。！？!?])/)[0]?.trim() || title
  if (firstSentence.length <= 40) return firstSentence
  return `${firstSentence.slice(0, 40)}…`
}

function ProblemRow({ problem, onClick }: { problem: BigProblem; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition hover:bg-slate-50"
      onClick={onClick}
    >
      <span className={cn('h-3 w-3 shrink-0 rounded-full', severityDot[problem.severity])} />
      <span className="min-w-0 flex-1">
        <span className="text-sm font-medium text-slate-950">{shortTitleOf(problem.title)}</span>
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
  locator,
  onClose,
}: {
  problem: BigProblem
  locator: Locator
  onClose: () => void
}) {
  const [showMeta, setShowMeta] = useState(false)
  const [highlightLine, setHighlightLine] = useState<number | null>(null)
  const docContainerRef = useRef<HTMLDivElement>(null)

  const positionLines = useMemo(
    () => new Map(problem.positions.map((position) => [position.lineIndex, position])),
    [problem],
  )

  // 位置列表点击 → 滚动到原文对应行并高亮
  const jumpToLine = (lineIndex: number) => {
    setHighlightLine(lineIndex)
    const target = docContainerRef.current?.querySelector(`[data-line="${lineIndex}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // 排序后的位置清单（按行号顺序）
  const orderedPositions = useMemo(
    () => [...problem.positions].sort((a, b) => a.lineIndex - b.lineIndex),
    [problem],
  )

  // 判定依据仅在"多处联合"时才有展示意义：单处问题不存在"为什么这几处算同一个问题"
  const showJudgment = problem.positionRelation === 'joint' && problem.positions.length >= 2 && (problem.groupingLogic || problem.why)

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="overflow-y-auto" ref={docContainerRef}>
          {/* 问题说明：第一眼看到完整现象 */}
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
                  ) : (
                    <Badge>{problem.positions.length} 处位置</Badge>
                  )}
                </div>
                <p className="mt-2 text-base leading-7 text-slate-900">{problem.title}</p>
              </div>
              <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={onClose}>
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* 应对思路 */}
          {problem.actionSummary ? (
            <div className="border-b border-slate-200 px-6 py-4">
              <p className="text-sm leading-6 text-slate-800">
                <span className="font-medium text-slate-950">应对思路：</span>
                {problem.actionSummary}
              </p>
            </div>
          ) : null}

          {/* 位置清单：按行号排序，一条=一个位置+该处的问题说明，点击跳转下方原文对应行 */}
          {!problem.isGlobal && orderedPositions.length > 0 ? (
            <div className="border-b border-slate-200 px-6 py-4">
              <h3 className="text-sm font-semibold text-slate-950">涉及位置（{orderedPositions.length} 处）</h3>
              <div className="mt-2 space-y-1.5">
                {orderedPositions.map((position) => (
                  <button
                    key={position.lineIndex}
                    type="button"
                    className="flex w-full items-start gap-2.5 rounded-md border border-slate-200 px-3 py-2 text-left transition hover:border-slate-300 hover:bg-slate-50"
                    onClick={() => jumpToLine(position.lineIndex)}
                  >
                    <span className="mt-0.5 shrink-0 rounded bg-red-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-red-600">
                      第 {position.lineIndex + 1} 行
                    </span>
                    <span className="min-w-0 flex-1 text-xs leading-5 text-slate-700">{position.reason}</span>
                    <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* 判定依据：仅多处联合时展示(单处问题不存在"为什么这几处算同一个") */}
          {showJudgment ? (
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

          {/* 原文（只标本问题位置，点击上方位置清单可跳转到这里） */}
          <div className="px-2 py-3 font-mono text-xs leading-6">
            {problem.isGlobal ? (
              <p className="px-4 py-4 text-center font-sans text-sm text-slate-500">
                这个问题针对文档整体，没有绑定到具体某一行。
              </p>
            ) : (
              locator.lines.map((line, index) => {
                const position = positionLines.get(index)
                const highlighted = highlightLine === index
                if (!position) {
                  return (
                    <div key={index} data-line={index} className="flex gap-3 px-3">
                      <span className="w-8 shrink-0 select-none text-right text-slate-300">{index + 1}</span>
                      <span className="whitespace-pre-wrap break-all text-slate-600">{line || ' '}</span>
                    </div>
                  )
                }
                return (
                  <div key={index} data-line={index}>
                    <div
                      className={cn(
                        'flex w-full gap-3 rounded px-3 transition',
                        highlighted ? 'bg-amber-100 ring-2 ring-amber-400' : 'bg-red-50',
                      )}
                    >
                      <span className="w-8 shrink-0 select-none text-right font-semibold text-red-500">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-medium text-slate-900">
                        {line || ' '}
                      </span>
                    </div>
                    <div className="ml-11 mr-3 my-1.5 rounded-md border border-red-100 bg-white px-3 py-2 font-sans">
                      <p className="whitespace-pre-line text-xs leading-5 text-slate-600">{position.reason}</p>
                    </div>
                  </div>
                )
              })
            )}
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
  onOpenFixWorkbench,
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
      <section className="rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100 p-5">
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
      <section className="rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100 p-5">
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
      <section className="rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100">
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
                            <span className="text-xs font-semibold text-slate-900">{shortTitleOf(problem.title)}</span>
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

      {/* 修改 + 导出 */}
      <section className="grid gap-2 md:grid-cols-3">
        <Button type="button" variant="primary" onClick={onOpenFixWorkbench}>
          <Pencil className="h-4 w-4" />
          生成修改方案
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
          locator={locator}
          onClose={() => setDetailKey(null)}
        />
      ) : null}
    </div>
  )
}
