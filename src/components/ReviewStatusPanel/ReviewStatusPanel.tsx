import { AlertTriangle, BarChart3, ChevronDown, ChevronRight, Download, FileText, ListChecks, Loader2, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import type {
  IssueGroup,
  PrescriptionPriorityAction,
  ReviewProgressEvent,
  ReviewReport,
} from '../../types/reviewReport.types'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'

interface ReviewStatusPanelProps {
  running: boolean
  events: ReviewProgressEvent[]
  report: ReviewReport | null
  onShowIssues: () => void
  onOpenIssue: (issue: IssueGroup) => void
  onPreviewRevisedDocument: () => void
  onExportJson: () => void
  onExportMarkdown: () => void
}

function interactionModeLabel(value: ReviewReport['document_profile']['interaction_mode']) {
  if (value === 'single_turn') return '单轮'
  if (value === 'multi_turn') return '多轮'
  return '未明确'
}

function findRelatedIssues(report: ReviewReport, action: PrescriptionPriorityAction) {
  // 与ReportView.tsx里findIssue同样的宽松匹配逻辑：防止B2自行简化id导致精确匹配失败时静默丢失关联issue
  return action.related_issue_ids
    .map((id) => ({
      id,
      issue: report.issues.find((issue) =>
        issue.id === id ||
        issue.locations.some((location) => location.source_issue_id === id) ||
        (id.length >= 8 && (issue.id.includes(id) || id.includes(issue.id))),
      ),
    }))
}

export function ReviewStatusPanel({
  running,
  events,
  report,
  onShowIssues,
  onOpenIssue,
  onPreviewRevisedDocument,
  onExportJson,
  onExportMarkdown,
}: ReviewStatusPanelProps) {
  const latest = events.at(-1)
  const completed = latest?.completed ?? 0
  const total = latest?.total ?? 0
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100)
  const errors = latest?.errors ?? []
  const [expandedActionPriority, setExpandedActionPriority] = useState<number | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const [showProfileDetail, setShowProfileDetail] = useState(false)
  const sortedPriorityActions = useMemo(
    () => report?.prescription.priority_actions.slice().sort((a, b) => a.priority - b.priority) ?? [],
    [report],
  )

  if (running) {
    return (
      <section className="rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-950">正在审查</h2>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-3 text-xs text-slate-500">
          已发现 {latest?.foundCount ?? 0} 个候选问题
        </div>
        {errors.length > 0 ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {errors.slice(-3).map((error) => (
              <div key={error}>{error}</div>
            ))}
          </div>
        ) : null}
      </section>
    )
  }

  if (report) {
    const profile = report.document_profile
    const prescription = report.prescription
    const checkPlan = report.check_plan ?? []
    const skippedChecks = checkPlan.filter((entry) => entry.decision === 'skip')
    const ranCheckCount = checkPlan.filter((entry) => entry.decision === 'run').length || report.meta.skills_run.length
    const expandedAction = sortedPriorityActions.find((action) => action.priority === expandedActionPriority)
    const relatedIssues = expandedAction ? findRelatedIssues(report, expandedAction) : []

    return (
      <div className="space-y-4">
        {report.incomplete_checks.length > 0 ? (
          <section className="rounded-lg border border-red-200 bg-red-50 p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
              <div>
                <h2 className="text-sm font-semibold text-red-950">本次报告可能不完整</h2>
                <p className="mt-1 text-sm leading-6 text-red-800">
                  以下检查项本次未能获得任何模型判断结果，相关问题可能没有出现在检测细节或综合处方中。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {report.incomplete_checks.map((check) => (
                    <Badge key={check.skill_id} className="border-red-200 bg-white text-red-800">
                      {check.skill_title} · {check.skill_id}
                    </Badge>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-5 text-red-700">
                  模型检查完成 {report.meta.actual_skill_model_calls}/{report.meta.expected_skill_model_calls}
                </p>
              </div>
            </div>
          </section>
        ) : null}

        <section className="rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100 p-5">
          <div className="mb-4 flex items-center gap-2">
            <FileText className="h-4 w-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-950">我们理解这份提示词是</h2>
          </div>
          <p className="text-base font-semibold leading-7 text-slate-950">{profile.document_purpose}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-500">输出对象</div>
              <div className="mt-1 text-sm font-medium text-slate-900">{profile.output_consumer}</div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-500">交互模式</div>
              <div className="mt-1 text-sm font-medium text-slate-900">
                {interactionModeLabel(profile.interaction_mode)}
              </div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-500">审查范围</div>
              <div className="mt-1 text-sm font-medium text-slate-900">
                {ranCheckCount} 项检查 · {report.meta.models_used.length} 个模型交叉验证
              </div>
            </div>
          </div>
          {skippedChecks.length > 0 ? (
            <div className="mt-3">
              <button
                type="button"
                className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-600"
                onClick={() => setShowSkipped((value) => !value)}
              >
                <ListChecks className="h-3 w-3" />
                {skippedChecks.length} 项检查判断为不适用，未执行
                {showSkipped ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
              {showSkipped ? (
                <ul className="mt-1.5 space-y-1">
                  {skippedChecks.map((entry) => (
                    <li key={entry.skill_id} className="text-[11px] leading-5 text-slate-500">
                      <span className="font-medium text-slate-600">{entry.skill_title}</span>：{entry.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <p className="mt-3 text-xs leading-5 text-slate-500">
            后续所有判断都基于这个理解。如果理解有偏差，请在左侧“补充说明”中纠正后重新审查。
          </p>
          {profile.confidence_note ? (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              {profile.confidence_note}
            </p>
          ) : null}
          {(profile.declared_exclusions.length > 0 || profile.internal_conventions.length > 0) ? (
            <div className="mt-3">
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-800"
                onClick={() => setShowProfileDetail((current) => !current)}
              >
                {showProfileDetail ? '收起' : '查看'}系统对这份文档的完整理解
                {showProfileDetail ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
              {showProfileDetail ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-2 text-xs font-medium text-slate-500">文档自己声明不涉及的场景</div>
                    {profile.declared_exclusions.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {profile.declared_exclusions.map((item) => <Badge key={item}>{item}</Badge>)}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500">未发现明确排除项</p>
                    )}
                  </div>
                  <div>
                    <div className="mb-2 text-xs font-medium text-slate-500">识别到的文档内部写法习惯</div>
                    {profile.internal_conventions.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {profile.internal_conventions.map((item) => <Badge key={item}>{item}</Badge>)}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500">未识别出特殊约定</p>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100 p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-slate-500" />
              <h2 className="text-sm font-semibold text-slate-950">综合处方</h2>
            </div>
            <p className="text-xs text-slate-500">最终把关模型：{report.meta.consolidation_model || '未执行'}</p>
          </div>

          <p className="rounded-md bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
            {prescription.overall_assessment}
          </p>

          <div className="mt-4 space-y-3">
            {sortedPriorityActions.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                暂无优先修改动作
              </div>
            ) : (
              sortedPriorityActions.map((action) => {
                const expanded = action.priority === expandedActionPriority
                return (
                  <article key={`${action.priority}-${action.problem_statement}`} className="rounded-lg border border-slate-200">
                    <button
                      type="button"
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
                      onClick={() => setExpandedActionPriority(expanded ? null : action.priority)}
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-950 text-sm font-semibold text-white">
                        {action.priority}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-semibold leading-6 text-slate-950">{action.problem_statement}</h3>
                        <p className="mt-1 text-xs leading-5 text-slate-600">
                          <span className="font-medium text-slate-700">应对思路：</span>{action.action_summary}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">{action.why}</p>
                        {action.conflicts_resolved ? (
                          <p className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-900">
                            {action.conflicts_resolved}
                          </p>
                        ) : null}
                      </div>
                      {expanded ? (
                        <ChevronDown className="mt-1 h-4 w-4 text-slate-500" />
                      ) : (
                        <ChevronRight className="mt-1 h-4 w-4 text-slate-500" />
                      )}
                    </button>
                  </article>
                )
              })
            )}
          </div>

          {expandedAction ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <h3 className="mb-3 text-xs font-semibold text-slate-600">关联检测细节</h3>
              <div className="space-y-2">
                {relatedIssues.length === 0 ? (
                  <p className="text-sm text-slate-500">这条处方没有关联到具体 issue。</p>
                ) : (
                  relatedIssues.map(({ id, issue }) => (
                    issue ? (
                      <button
                        key={id}
                        type="button"
                        className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-left transition hover:bg-slate-100"
                        onClick={() => onOpenIssue(issue)}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-slate-950">{issue.title}</div>
                          {issue.profile_conflict ? (
                            <Badge className="border-violet-200 bg-violet-50 text-violet-700">
                              <AlertTriangle className="mr-1 h-3 w-3" />
                              画像待核实
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{issue.description}</div>
                      </button>
                    ) : (
                      <div key={id} className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500">
                        未能在当前合并清单中定位：{id}
                      </div>
                    )
                  ))
                )}
              </div>
            </div>
          ) : null}

          {prescription.minor_notes.length > 0 ? (
            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
              <h3 className="mb-2 text-xs font-semibold text-slate-600">次要建议</h3>
              <ul className="space-y-1 text-xs leading-5 text-slate-600">
                {prescription.minor_notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </div>
          ) : null}

          <div className="mt-4 grid gap-2 md:grid-cols-2">
            <Button
              type="button"
              variant={prescription.revised_document_available ? 'primary' : 'secondary'}
              onClick={onPreviewRevisedDocument}
              disabled={!prescription.revised_document_available}
            >
              查看改前改后完整对比
            </Button>
            <Button type="button" variant="secondary" onClick={onShowIssues}>
              查看全部检测细节
            </Button>
            <Button type="button" variant="secondary" onClick={onExportJson}>
              <Download className="h-4 w-4" />
              导出完整数据（JSON）
            </Button>
            <Button type="button" variant="secondary" onClick={onExportMarkdown}>
              <Download className="h-4 w-4" />
              导出可读报告（Markdown）
            </Button>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            {prescription.revised_document_diff_summary}
          </p>
        </section>
      </div>
    )
  }

  return (
    <section className="rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-950">等待开始</h2>
      </div>
      <p className="text-sm leading-6 text-slate-600">
        在左侧粘贴 System Prompt，选择模型和审查项后开始审查。最终结果会先合并重复问题，再展示一份干净的问题清单。
      </p>
    </section>
  )
}
