import { History, Play, ShieldCheck, Square, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ConsolidationModelPicker } from './components/ConsolidationModelPicker/ConsolidationModelPicker'
import { DiffPreview } from './components/DiffPreview/DiffPreview'
import { FixWorkbench } from './components/FixWorkbench/FixWorkbench'
import { IssueDetailPanel } from './components/IssueDetailPanel/IssueDetailPanel'
import { ReportView } from './components/ReportView/ReportView'
import { ModelSelector } from './components/ModelSelector/ModelSelector'
import { PromptInput } from './components/PromptInput/PromptInput'
import { ReviewStatusPanel } from './components/ReviewStatusPanel/ReviewStatusPanel'
import { ScenarioHintInput } from './components/ScenarioHintInput/ScenarioHintInput'
import { SkillSelector } from './components/SkillSelector/SkillSelector'
import { Button } from './components/ui/Button'
import { applyFix } from './core/fixApplier/applyFix'
import { generateDiff, type DiffResult } from './core/fixApplier/generateDiff'
import { DEFAULT_MODELS, listOpenRouterModels } from './core/modelProvider/providerAdapter'
import { runReview } from './core/orchestrator/runReview'
import { generateFixPlans, strongestConfidenceOf, type ActionLocationHint, type FixPlan } from './core/orchestrator/fixPlanGenerator'
import { selectConsolidationModel } from './core/orchestrator/consolidationModelSelector'
import { calculateReviewScore } from './core/orchestrator/scoreCalculator'
import { loadBuiltinSkills } from './core/skillLoader/loadBuiltinSkills'
import { loadUserSkills } from './core/skillLoader/loadUserSkills'
import { deleteReviewRecord, listReviewRecords, saveDraftRevision, saveReviewRecord } from './core/storage/indexedDbStore'
import type { ReviewHistoryRecord } from './core/storage/indexedDbStore'
import { encryptAndStoreApiKey, loadDecryptedApiKey } from './core/storage/keyEncryption'
import {
  getStoredApiKeyMask,
  hasStoredEncryptedApiKey,
  loadModelPrefs,
  saveModelPrefs,
} from './core/storage/localStoragePrefs'
import type {
  Issue,
  IssueGroup,
  ModelConfig,
  PrescriptionPriorityAction,
  ReviewProgressEvent,
  ReviewReport,
  SeverityDisplay,
  SkillDefinition,
} from './types/reviewReport.types'

declare global {
  interface Window {
    __BUTLER_LAST_REVIEW_REPORT__?: ReviewReport
  }
}

function exposeReportForDebug(report: ReviewReport) {
  if (!import.meta.env.DEV) return
  window.__BUTLER_LAST_REVIEW_REPORT__ = report
  let script = document.getElementById('butler-last-review-report') as HTMLScriptElement | null
  if (!script) {
    script = document.createElement('script')
    script.id = 'butler-last-review-report'
    script.type = 'application/json'
    document.body.appendChild(script)
  }
  script.textContent = JSON.stringify(report)
}

function loadInitialModels() {
  const prefs = loadModelPrefs()
  const selectedPrefs = prefs?.filter((model) => model.provider === 'openrouter' && model.selected).slice(0, 3)
  if (selectedPrefs?.length) return selectedPrefs
  return DEFAULT_MODELS
}

function severityForDisplay(severity: SeverityDisplay): Issue['severity'] {
  if (severity === '严重') return 'critical'
  if (severity === '轻微') return 'info'
  return 'major'
}

function isV5Report(report: ReviewReport) {
  return Boolean(report.document_profile && report.prescription) &&
    Array.isArray(report.incomplete_checks) &&
    Array.isArray(report.issues) &&
    report.issues.every((issue) => 'merge_type' in issue)
}

function localDateForFilename(value: string) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function promptSummaryForFilename(targetSp: string, report: ReviewReport) {
  const firstLine = targetSp.split(/\n/).map((line) => line.trim()).find(Boolean)
  const source = firstLine || report.document_profile.document_purpose || 'system-prompt'
  const summary = source
    .replace(/^你是/, '')
    .split(/[。.!?？]/)[0]
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 28)
  return summary || 'system-prompt'
}

function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const NATURE_TEXT: Record<string, string> = {
  wording: '表述问题',
  flow: '流程设计',
  engineering: '工程实现',
  safety: '安全合规',
}

const SEVERITY_RANK_MD: Record<SeverityDisplay, number> = { 严重: 0, 中等: 1, 轻微: 2 }

/**
 * 与ReportView.tsx里buildBigProblems的严重度计算同一思路(取关联issue里最严重的那个，仅供参考的单模型发现不参与排序)，
 * 因Markdown导出是单独的字符串拼接函数，为避免过度抽取共享模块带来的联动风险，这里轻量独立实现一份。
 */
function actionSeverity(report: ReviewReport, action: PrescriptionPriorityAction): SeverityDisplay {
  const findIssue = (id: string) =>
    report.issues.find(
      (issue) =>
        issue.id === id ||
        issue.locations.some((location) => location.source_issue_id === id) ||
        (id.length >= 8 && (issue.id.includes(id) || id.includes(issue.id))),
    )
  const related = action.related_issue_ids.map(findIssue).filter((issue): issue is IssueGroup => Boolean(issue))
  const confirmedRelated = related.filter((issue) => issue.confidence_display !== '仅供参考')
  if (confirmedRelated.length === 0) return '中等'
  return confirmedRelated.reduce<SeverityDisplay>(
    (acc, issue) => (SEVERITY_RANK_MD[issue.severity_display] < SEVERITY_RANK_MD[acc] ? issue.severity_display : acc),
    '轻微',
  )
}

function buildReportMarkdown(report: ReviewReport, targetSp: string) {
  const title = promptSummaryForFilename(targetSp, report)
  const profile = report.document_profile
  const actions = report.prescription.priority_actions
    .slice()
    .sort((a, b) => a.priority - b.priority)

  const score = calculateReviewScore({
    issues: report.issues,
    checkPlan: report.check_plan ?? [],
    documentProfile: profile,
    scenarioHint: report.meta.scenario_hint,
    targetSp,
    fallbackSkillsRun: report.meta.skills_run,
  })
  const dimensionLines = score.dimensions
    .map((dim) => dim.score === null
      ? `- ${dim.label}：未检（本次检查项全部不适用）`
      : `- ${dim.label}：${dim.score} 分（权重 ${dim.weight}，${dim.weightReason}）`)
    .join('\n')

  const fixPlanFor = (priority: number) => (report.fix_plans ?? []).find((plan) => plan.action_priority === priority)

  // 与网页端同样的信息层次：标题=现象(problem_statement)，应对思路紧跟其后(主体信息)，
  // 具体改法用代码块展示(模拟网页的before/after卡片)，判断依据(grouping_logic、why)用details折叠块弱化，
  // 不再把五种信息拴在一段里密密麻麻紧贴在一起。
  const severityMark = (severity: string) => (severity === '严重' ? '\u{1F534}' : severity === '中等' ? '\u{1F7E0}' : '\u26AA')
  const buildFixSection = (plan: ReturnType<typeof fixPlanFor>) => {
    if (!plan) return ''
    if (plan.edits.length === 0) {
      return `\n**具体修改**：${plan.no_fix_reason ?? '需要业务决策，无法给出文字级修复。'}\n`
    }
    const modeNote = plan.apply_mode === 'group' ? `（以下 ${plan.edits.length} 处必须作为一组一起应用）` : '（每处可单独应用）'
    const editBlocks = plan.edits.map((edit, index) =>
      `${plan.edits.length > 1 ? `— 第 ${index + 1} 处 —\n` : ''}` +
      '```diff\n' +
      `- ${edit.before_text}\n` +
      `+ ${edit.after_text}\n` +
      '```\n' +
      `> ${edit.note}\n`,
    ).join('\n')
    return `\n**具体修改** ${modeNote}\n${plan.confidence_caveat ? '\n> ⚠️ 这个问题仅由单个模型提出（未获得交叉确认），以下修法仅供参考，建议人工复核后再应用。\n' : ''}\n${editBlocks}`
  }

  const problems = actions.length > 0
    ? actions.map((action) => {
        const nature = action.nature ? `\`${NATURE_TEXT[action.nature] ?? action.nature}\`` : ''
        const relation = action.position_relation === 'joint' ? ' · 多处联合构成' : ''
        const plan = fixPlanFor(action.priority)
        const judgmentLines: string[] = []
        if (action.grouping_logic) judgmentLines.push(`为什么这几处是同一个问题：${action.grouping_logic}`)
        if (action.why) judgmentLines.push(`优先处理理由：${action.why}`)
        if (action.conflicts_resolved) judgmentLines.push(`矛盾裁决：${action.conflicts_resolved}`)
        const judgmentSection = judgmentLines.length > 0
          ? `\n<details>\n<summary>查看判定依据</summary>\n\n${judgmentLines.map((line) => `> ${line}`).join('\n>\n')}\n\n</details>\n`
          : ''
        return `### ${severityMark(actionSeverity(report, action))} ${action.priority}. ${action.problem_statement} ${nature}${relation}\n\n**应对思路**：${action.action_summary}\n${buildFixSection(plan)}${judgmentSection}`
      }).join('\n\n---\n\n')
    : '没有需要处理的问题。'

  const skipped = (report.check_plan ?? []).filter((entry) => entry.decision === 'skip')
  const skippedSection = skipped.length > 0
    ? `\n## 本次跳过的检查\n\n${skipped.map((entry) => `- ${entry.skill_title}：${entry.reason}`).join('\n')}\n`
    : ''
  const incompleteSection = report.incomplete_checks.length > 0
    ? `\n## 未完成检查（报告可能不完整）\n\n${report.incomplete_checks.map((check) =>
      `- ${check.skill_title}（${check.skill_id}）`,
    ).join('\n')}\n`
    : ''
  const referenceIssues = report.issues.filter((issue) => issue.confidence_display === '仅供参考')
  const referenceSection = referenceIssues.length > 0
    ? `\n## 附：单个模型提出的意见（未获多模型确认，仅供参考）\n\n${referenceIssues.map((issue) =>
      `- ${issue.title}：${issue.description.split('\n')[0].slice(0, 100)}`,
    ).join('\n')}\n`
    : ''

  // 开头目录：纯文本环境里也先让人一眼扫到规模，不用滚到底才知道有几个问题
  const severityCounts: Record<string, number> = { 严重: 0, 中等: 0, 轻微: 0 }
  actions.forEach((action) => {
    const key = actionSeverity(report, action)
    severityCounts[key] = (severityCounts[key] ?? 0) + 1
  })
  const overviewLine = actions.length > 0
    ? `共发现 ${actions.length} 个优先问题：\u{1F534} 严重 ${severityCounts.严重} · \u{1F7E0} 中等 ${severityCounts.中等} · \u26AA 轻微 ${severityCounts.轻微}`
    : '本次未发现需优先处理的问题。'

  return `# Arbiter 审查报告：${title}

审查时间：${new Date(report.meta.timestamp).toLocaleString()}
检查：${report.meta.skills_run.length} 项 · ${report.meta.models_used.length} 个模型交叉验证（调用完成 ${report.meta.actual_skill_model_calls}/${report.meta.expected_skill_model_calls}）
${incompleteSection}
## 文档理解

${profile.document_purpose}（输出给：${profile.output_consumer}）

## 体检得分：${score.total} / 100

${dimensionLines}

做得好：${score.strengths.join('、') || '（无）'}
待改进：${score.weaknesses.join('、') || '（无）'}

计分规则：只按多模型确认的问题扣分；未检维度不参与总分；权重由文档特征决定。

## 主要问题

${overviewLine}

${problems}
${report.prescription.minor_notes.length > 0 ? `\n## 次要建议\n\n${report.prescription.minor_notes.map((note) => `- ${note}`).join('\n')}\n` : ''}${skippedSection}${referenceSection}`
}

function App() {
  const [targetSp, setTargetSp] = useState('')
  const [scenarioHint, setScenarioHint] = useState('')
  const [skills, setSkills] = useState<SkillDefinition[]>([])
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [recommendedDomainIds, setRecommendedDomainIds] = useState<Set<string>>(new Set())
  const [models, setModels] = useState<ModelConfig[]>(loadInitialModels)
  const [manualConsolidationModelId, setManualConsolidationModelId] = useState<string | null>(null)
  const [hasApiKey, setHasApiKey] = useState(() => hasStoredEncryptedApiKey())
  const [apiKeyMask, setApiKeyMask] = useState(() => getStoredApiKeyMask())
  // 检查官模型/最终把关模型共享同一份完整模型列表，打通两处的搜索池，不再各自只能搜到已选的3个
  const [availableModels, setAvailableModels] = useState<ModelConfig[]>(
    DEFAULT_MODELS.map((model) => ({ ...model, selected: false })),
  )
  const [modelListStatus, setModelListStatus] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [events, setEvents] = useState<ReviewProgressEvent[]>([])
  const [report, setReport] = useState<ReviewReport | null>(null)
  const [, setShowIssues] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<ReviewHistoryRecord[]>([])
  const [detailIssue, setDetailIssue] = useState<IssueGroup | null>(null)
  const [previewIssue, setPreviewIssue] = useState<Issue | null>(null)
  const [previewDiff, setPreviewDiff] = useState<DiffResult | null>(null)
  const [previewApply, setPreviewApply] = useState<(() => Promise<void>) | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  // 整体修改工作台：点击“生成修改方案”时才按需生成(传入完整位置清单要求逐位置覆盖)，生成后缓存
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [workbenchLoading, setWorkbenchLoading] = useState(false)
  const [workbenchError, setWorkbenchError] = useState<string | null>(null)
  const [workbenchPlans, setWorkbenchPlans] = useState<FixPlan[]>([])
  const workbenchCacheKeyRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadSkills() {
      const builtin = loadBuiltinSkills()
      const userSkills = await loadUserSkills()
      if (cancelled) return
      const allSkills = [...builtin, ...userSkills]
      setSkills(allSkills)
      setSelectedSkillIds(new Set(allSkills.filter((skill) => skill.enabledByDefault).map((skill) => skill.id)))
    }
    void loadSkills()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    saveModelPrefs(models)
  }, [models])

  // 页面打开时自动拉取完整模型列表(不用等用户手动点“读取模型”)，没有存过Key时静默降级为默认列表，不报错打断页面
  useEffect(() => {
    let cancelled = false
    async function autoLoadModels() {
      if (!hasApiKey) return
      const apiKey = await loadDecryptedApiKey()
      if (!apiKey || cancelled) return
      setModelListStatus('正在读取 OpenRouter 模型列表...')
      try {
        const fetchedModels = await listOpenRouterModels(apiKey)
        if (cancelled) return
        setAvailableModels(fetchedModels)
        setModelListStatus(`已读取 ${fetchedModels.length.toLocaleString()} 个可用模型`)
      } catch {
        if (cancelled) return
        setModelListStatus('暂时无法读取完整模型列表，已使用默认模型')
      }
    }
    void autoLoadModels()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshAvailableModels = async (apiKey: string | null) => {
    if (!apiKey) {
      setModelListStatus('请先保存 OpenRouter API Key')
      return
    }
    setModelListStatus('正在读取 OpenRouter 模型列表...')
    try {
      const fetchedModels = await listOpenRouterModels(apiKey)
      setAvailableModels(fetchedModels)
      setModelListStatus(`已读取 ${fetchedModels.length.toLocaleString()} 个可用模型`)
    } catch {
      setAvailableModels(DEFAULT_MODELS.map((model) => ({ ...model, selected: false })))
      setModelListStatus('暂时无法读取完整模型列表，已使用默认模型')
    }
  }

  useEffect(() => {
    void listReviewRecords().then(setHistory)
  }, [])

  useEffect(() => {
    const text = targetSp.toLowerCase()
    const recommended = skills
      .filter((skill) => skill.source === 'domain')
      .filter((skill) => {
        if (skill.id === 'code_generation') return /代码|函数|接口|api|bug|typescript|python|生成代码/i.test(text)
        if (skill.id === 'general_writing') return /写作|文案|文章|标题|摘要|改写|润色/i.test(text)
        if (skill.id === 'yoroll_cover_v14_4') return /yoroll|cover|封面|画面|视觉|分镜/i.test(text)
        return false
      })
      .map((skill) => skill.id)
    setRecommendedDomainIds(new Set(recommended))
    if (recommended.length > 0) {
      setSelectedSkillIds((current) => new Set([...current, ...recommended]))
    }
  }, [targetSp, skills])

  const selectedSkills = useMemo(
    () => skills.filter((skill) => selectedSkillIds.has(skill.id)),
    [skills, selectedSkillIds],
  )
  const selectedModelCount = models.filter((model) => model.selected).length
  const selectedSkillsNeedModel = selectedSkills.some((skill) => skill.execution_mode !== 'static_check')

  const toggleSkill = (skillId: string) => {
    setSelectedSkillIds((current) => {
      const next = new Set(current)
      if (next.has(skillId)) next.delete(skillId)
      else next.add(skillId)
      return next
    })
  }

  const addUserSkill = (skill: SkillDefinition) => {
    setSkills((current) => {
      const withoutOld = current.filter((item) => item.id !== skill.id)
      return [...withoutOld, skill]
    })
    setSelectedSkillIds((current) => new Set([...current, skill.id]))
  }

  const handleSaveApiKey = async (value: string) => {
    await encryptAndStoreApiKey(value)
    setHasApiKey(true)
    setApiKeyMask(getStoredApiKeyMask())
  }

  const refreshHistory = async () => {
    setHistory(await listReviewRecords())
  }

  const removeHistoryRecord = async (id: string, event: { stopPropagation: () => void }) => {
    event.stopPropagation()
    await deleteReviewRecord(id)
    await refreshHistory()
  }

  const startReview = async () => {
    if (running) return
    setError(null)
    setEvents([])
    setReport(null)
    setShowIssues(false)
    setDetailIssue(null)

    if (!targetSp.trim()) {
      setError('请先粘贴要审查的 System Prompt。')
      return
    }
    if (selectedSkills.length === 0) {
      setError('请至少选择一个审查项。')
      return
    }
    if (selectedSkillsNeedModel && selectedModelCount < 1) {
      setError('包含语义判断的审查需要选择至少 1 个检查官模型。')
      return
    }

    const controller = new AbortController()
    abortControllerRef.current = controller
    setRunning(true)
    try {
      const apiKey = await loadDecryptedApiKey()
      const reviewId = crypto.randomUUID()
      const finalReport = await runReview({
        reviewId,
        targetSp,
        scenarioHint,
        selectedSkills,
        selectedModels: models,
        manualConsolidationModelId,
        manualConsolidationModelCandidates: availableModels,
        apiKey,
        signal: controller.signal,
        onProgress: (event) => {
          setEvents((current) => [...current, event])
        },
      })
      setReport(finalReport)
      exposeReportForDebug(finalReport)
      if (finalReport.meta.degraded) {
        setError(finalReport.meta.degraded_reason ?? '本次审查未完整结束，以下为已完成部分的结果。')
      }
      await saveReviewRecord({
        id: reviewId,
        createdAt: new Date().toISOString(),
        title: targetSp.slice(0, 64) || 'Untitled review',
        targetSp,
        scenarioHint,
        report: finalReport,
      })
      await refreshHistory()
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : '审查失败')
    } finally {
      setRunning(false)
      abortControllerRef.current = null
    }
  }

  const stopReview = () => {
    abortControllerRef.current?.abort()
  }

  const makePseudoIssue = (issueGroup: IssueGroup, markerIndex: number): Issue | null => {
    const location = issueGroup.locations.find((item) => item.marker_index === markerIndex)
    const fixItem = issueGroup.fix_items.find((item) => item.marker_index === markerIndex)
    if (!location || !fixItem?.fix) return null

    return {
      id: `${issueGroup.id}-${markerIndex}`,
      skill_id: issueGroup.related_skill_ids[0] ?? issueGroup.id,
      category: issueGroup.category,
      status: 'found',
      severity: severityForDisplay(issueGroup.severity_display),
      evidence_type: issueGroup.confidence_display === '高' ? 'explicit_omission' : 'semantic_inference',
      domain_specific: issueGroup.domain_specific,
      location: {
        anchor_before: location.anchor_before,
        anchor_after: location.anchor_after,
        matched_text: location.matched_text,
        ambiguous: location.ambiguous,
      },
      description: issueGroup.description,
      fix: {
        ...fixItem.fix,
        fix_requires_review: true,
      },
    }
  }

  const previewFix = (issueGroup: IssueGroup, markerIndex: number) => {
    const pseudoIssue = makePseudoIssue(issueGroup, markerIndex)
    if (!pseudoIssue) return
    const diff = generateDiff(targetSp, pseudoIssue)
    setPreviewIssue(pseudoIssue)
    setPreviewDiff(diff)
    setPreviewApply(() => async () => {
      if (!diff.ok) throw new Error(diff.reason ?? '无法生成可应用的修改。')
      const next = applyFix(targetSp, pseudoIssue, true)
      await saveDraftRevision({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        issueId: pseudoIssue.id,
        before: targetSp,
        after: next,
      })
      setTargetSp(next)
    })
  }

  const previewAllFixes = (issueGroup: IssueGroup) => {
    let next = targetSp
    const before = targetSp
    const appliedIds: string[] = []

    issueGroup.locations.forEach((location) => {
      if (location.ambiguous) return
      const pseudoIssue = makePseudoIssue(issueGroup, location.marker_index)
      if (!pseudoIssue) return
      const diff = generateDiff(next, pseudoIssue)
      if (!diff.ok) return
      next = diff.after
      appliedIds.push(pseudoIssue.id)
    })

    if (appliedIds.length === 0 || next === before) {
      setError('该问题没有可直接批量应用的修改。')
      return
    }

    const batchIssue: Issue = {
      id: `${issueGroup.id}-all`,
      skill_id: issueGroup.related_skill_ids[0] ?? issueGroup.id,
      category: issueGroup.category,
      status: 'found',
      severity: severityForDisplay(issueGroup.severity_display),
      evidence_type: issueGroup.confidence_display === '高' ? 'explicit_omission' : 'semantic_inference',
      domain_specific: issueGroup.domain_specific,
      location: {
        anchor_before: issueGroup.locations[0]?.anchor_before ?? '',
        anchor_after: issueGroup.locations[0]?.anchor_after ?? '',
        matched_text: issueGroup.locations[0]?.matched_text,
        ambiguous: false,
      },
      description: `${issueGroup.title}：批量应用 ${appliedIds.length} 处修改`,
      fix: null,
    }

    setPreviewIssue(batchIssue)
    setPreviewDiff({ ok: true, before, after: next })
    setPreviewApply(() => async () => {
      await saveDraftRevision({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        issueId: batchIssue.id,
        before,
        after: next,
      })
      setTargetSp(next)
    })
  }

  const confirmFix = async () => {
    if (!previewIssue || !previewApply) return
    try {
      await previewApply()
      setPreviewIssue(null)
      setPreviewDiff(null)
      setPreviewApply(null)
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : '应用修改失败')
    }
  }

  const previewRevisedDocument = () => {
    if (!report?.prescription.revised_document_available || !report.prescription.revised_document_after) {
      setError('本次综合处方没有可直接预览的完整改后版本。')
      return
    }

    const before = targetSp
    const after = report.prescription.revised_document_after
    const prescriptionIssue: Issue = {
      id: 'prescription-revised-document',
      skill_id: 'prescription',
      category: 'quality',
      status: 'found',
      severity: 'major',
      evidence_type: 'semantic_inference',
      scenario_assumption: 'inferred_from_text',
      location: {
        anchor_before: before.slice(0, 80),
        anchor_after: before.slice(-80),
        matched_text: before.slice(0, 80),
        ambiguous: false,
      },
      description: '综合处方生成的完整改后版本，需查看完整diff后确认应用。',
      fix: null,
    }

    setPreviewIssue(prescriptionIssue)
    setPreviewDiff({ ok: true, before, after })
    setPreviewApply(() => async () => {
      await saveDraftRevision({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        issueId: prescriptionIssue.id,
        before,
        after,
      })
      setTargetSp(after)
    })
  }

  /**
   * 打开整体修改工作台：点击时才按需生成修复方案。
   * 关键：把每个大问题关联的完整位置清单(locations)传给生成模型，要求逐位置覆盖，
   * 从根本上解决“9处问题只给1条修改”的脱节。生成结果按reviewId缓存，重复打开不重复花钱。
   */
  const openFixWorkbench = async () => {
    if (!report) return
    setWorkbenchOpen(true)
    const cacheKey = report.meta.review_id
    if (workbenchCacheKeyRef.current === cacheKey && workbenchPlans.length > 0) return // 已生成过，直接展示缓存
    setWorkbenchLoading(true)
    setWorkbenchError(null)
    try {
      const apiKey = await loadDecryptedApiKey()
      if (!apiKey) throw new Error('请先保存 API Key')
      // 宽松包含匹配(与ReportView同一套逻辑)：防止B2简化id导致关联issue丢失
      const findIssue = (id: string) =>
        report.issues.find(
          (issue) =>
            issue.id === id ||
            issue.locations.some((location) => location.source_issue_id === id) ||
            (id.length >= 8 && (issue.id.includes(id) || id.includes(issue.id))),
        )
      const locationHints: ActionLocationHint[] = report.prescription.priority_actions.map((action) => ({
        action_priority: action.priority,
        locations: action.related_issue_ids
          .map(findIssue)
          .filter((issue): issue is IssueGroup => Boolean(issue))
          .flatMap((issue) =>
            issue.locations
              .filter((location) => (location.matched_text ?? '').trim())
              .map((location) => ({
                matched_text: location.matched_text ?? '',
                reason: location.reason?.trim() || issue.description,
              })),
          ),
      }))
      const confidenceByPriority = new Map(
        report.prescription.priority_actions.map((action) => {
          const relatedGroups = action.related_issue_ids
            .map(findIssue)
            .filter((issue): issue is IssueGroup => Boolean(issue))
          return [action.priority, strongestConfidenceOf(relatedGroups.map((group) => group.confidence_display))] as const
        }),
      )
      const consolidationSelection = selectConsolidationModel({
        selectedModels: models.filter((model) => model.selected),
        manualModelId: manualConsolidationModelId,
        manualModelCandidates: availableModels,
      })
      const plans = await generateFixPlans({
        targetSp,
        documentProfile: report.document_profile,
        prescription: report.prescription,
        confidenceByPriority,
        locationHints,
        model: consolidationSelection.model,
        apiKey,
        reviewId: report.meta.review_id,
      })
      setWorkbenchPlans(plans)
      workbenchCacheKeyRef.current = cacheKey
    } catch (fixError) {
      setWorkbenchError(fixError instanceof Error ? fixError.message : '生成修改方案失败')
    } finally {
      setWorkbenchLoading(false)
    }
  }

  const exportReportJson = () => {
    if (!report) return
    const date = localDateForFilename(report.meta.timestamp)
    const summary = promptSummaryForFilename(targetSp, report)
    // JSON导出与MD同目标：只输出用户关心的问题内容本身，不包含raw_model_outputs等内部调试字段
    const score = calculateReviewScore({
      issues: report.issues,
      checkPlan: report.check_plan ?? [],
      documentProfile: report.document_profile,
      scenarioHint: report.meta.scenario_hint,
      targetSp,
      fallbackSkillsRun: report.meta.skills_run,
    })
    const cleanExport = {
      审查时间: new Date(report.meta.timestamp).toLocaleString(),
      文档理解: {
        用途: report.document_profile.document_purpose,
        输出给: report.document_profile.output_consumer,
      },
      体检得分: {
        总分: score.total,
        各维度: score.dimensions.map((dim) => ({
          维度: dim.label,
          分数: dim.score,
          权重: dim.weight,
        })),
        做得好: score.strengths,
        待改进: score.weaknesses,
      },
      主要问题: report.prescription.priority_actions.map((action) => ({
        优先级: action.priority,
        问题现象: action.problem_statement,
        应对思路: action.action_summary,
        优先处理理由: action.why,
        问题性质: action.nature ? NATURE_TEXT[action.nature] ?? action.nature : null,
        为什么这几处是同一个问题: action.grouping_logic || null,
        矛盾裁决: action.conflicts_resolved || null,
      })),
      次要建议: report.prescription.minor_notes,
      仅供参考的单模型意见: report.issues
        .filter((issue) => issue.confidence_display === '仅供参考')
        .map((issue) => ({ 标题: issue.title, 说明: issue.description.split('\n')[0] })),
    }
    downloadTextFile(
      `butler-report-${date}-${summary}.json`,
      `${JSON.stringify(cleanExport, null, 2)}\n`,
      'application/json;charset=utf-8',
    )
  }

  const exportReportMarkdown = () => {
    if (!report) return
    const date = localDateForFilename(report.meta.timestamp)
    const summary = promptSummaryForFilename(targetSp, report)
    downloadTextFile(
      `butler-report-${date}-${summary}.md`,
      buildReportMarkdown(report, targetSp),
      'text/markdown;charset=utf-8',
    )
  }

  const loadHistoryRecord = (record: ReviewHistoryRecord) => {
    setTargetSp(record.targetSp)
    setScenarioHint(record.scenarioHint ?? record.report.meta.scenario_hint ?? '')
    setEvents([])
    setError(null)

    if (!isV5Report(record.report)) {
      setReport(null)
      setShowIssues(false)
      setDetailIssue(null)
      setError('这条历史记录来自旧版报告结构，已载入原 prompt，请重新运行一次审查生成新报告。')
      return
    }

    setReport(record.report)
    exposeReportForDebug(record.report)
    setShowIssues(false)
  }

  return (
    <main className="min-h-screen text-slate-950">
      <header className="border-b border-indigo-100/60 bg-white/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1540px] items-center gap-3 px-4 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 via-blue-600 to-sky-500 text-white shadow-md shadow-indigo-200">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="bg-gradient-to-r from-indigo-700 via-blue-700 to-sky-600 bg-clip-text text-lg font-bold tracking-tight text-transparent">Arbiter</h1>
            <p className="text-sm text-slate-500">AI 指令审查工作台 · Prompt / Skill</p>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1540px] gap-4 px-4 py-4 xl:grid-cols-[520px_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <PromptInput value={targetSp} onChange={setTargetSp} />
          <ScenarioHintInput value={scenarioHint} onChange={setScenarioHint} />
          <ModelSelector
            models={models}
            onChange={setModels}
            hasStoredApiKey={hasApiKey}
            apiKeyMask={apiKeyMask}
            onSaveApiKey={handleSaveApiKey}
            onLoadStoredApiKey={loadDecryptedApiKey}
            availableModels={availableModels}
            modelListStatus={modelListStatus}
            onRefreshAvailableModels={refreshAvailableModels}
          />
          <ConsolidationModelPicker
            models={models}
            availableModels={availableModels}
            value={manualConsolidationModelId}
            onChange={setManualConsolidationModelId}
          />
          <SkillSelector
            skills={skills}
            selectedIds={selectedSkillIds}
            recommendedDomainIds={recommendedDomainIds}
            onToggle={toggleSkill}
            onSkillAdded={addUserSkill}
            targetSp={targetSp}
          />
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" className="flex-1" onClick={() => void startReview()} disabled={running}>
              <Play className="h-4 w-4" />
              {running ? '审查中' : '开始审查'}
            </Button>
            {running ? (
              <Button type="button" variant="danger" onClick={stopReview} title="停止审查，保留已完成部分的结果">
                <Square className="h-4 w-4" />
                停止
              </Button>
            ) : null}
          </div>
        </aside>

        <section className="space-y-4">
          {!report || running ? (
            <ReviewStatusPanel
              running={running}
              events={events}
              report={null}
              onShowIssues={() => setShowIssues(true)}
              onOpenIssue={setDetailIssue}
              onPreviewRevisedDocument={previewRevisedDocument}
              onExportJson={exportReportJson}
              onExportMarkdown={exportReportMarkdown}
            />
          ) : null}

          {report && !running ? (
            <ReportView
              key={report.meta.review_id}
              report={report}
              targetSp={targetSp}
              scenarioHint={scenarioHint}
              onOpenIssue={setDetailIssue}
              onExportJson={exportReportJson}
              onExportMarkdown={exportReportMarkdown}
              onOpenFixWorkbench={() => void openFixWorkbench()}
            />
          ) : null}

          <section className="rounded-xl border border-slate-200/70 bg-white shadow-sm shadow-slate-100 p-4">
            <div className="mb-3 flex items-center gap-2">
              <History className="h-4 w-4 text-slate-500" />
              <h2 className="text-sm font-semibold text-slate-950">历史记录</h2>
            </div>
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">暂无历史记录</p>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {history.slice(0, 8).map((record) => (
                  <div
                    key={record.id}
                    className="group relative block w-full rounded-md border border-slate-200 px-3 py-2 text-left text-xs transition hover:bg-slate-50"
                  >
                    <button type="button" className="block w-full pr-6 text-left" onClick={() => loadHistoryRecord(record)}>
                      <div className="font-medium text-slate-900">{record.title}</div>
                      <div className="mt-1 text-slate-500">
                        {new Date(record.createdAt).toLocaleString()} · {record.report.issues.length} 个问题
                      </div>
                    </button>
                    <button
                      type="button"
                      className="absolute right-2 top-2 rounded p-1 text-slate-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                      onClick={(event) => void removeHistoryRecord(record.id, event)}
                      title="删除这条历史记录"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </section>
      </div>

      <IssueDetailPanel
        issue={detailIssue}
        targetSp={targetSp}
        rawModelOutputs={report?.raw_model_outputs ?? []}
        onPreviewFix={previewFix}
        onPreviewAllFixes={previewAllFixes}
        onClose={() => setDetailIssue(null)}
      />

      <DiffPreview
        issue={previewIssue}
        diff={previewDiff}
        onConfirm={() => void confirmFix()}
        onCancel={() => {
          setPreviewIssue(null)
          setPreviewDiff(null)
          setPreviewApply(null)
        }}
      />

      {workbenchOpen && report ? (
        <FixWorkbench
          targetSp={targetSp}
          fixPlans={workbenchPlans}
          actions={report.prescription.priority_actions}
          loading={workbenchLoading}
          error={workbenchError}
          onClose={() => setWorkbenchOpen(false)}
        />
      ) : null}
    </main>
  )
}

export default App
