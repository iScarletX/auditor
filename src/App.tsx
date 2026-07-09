import { History, Play, ShieldCheck, Square, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ConsolidationModelPicker } from './components/ConsolidationModelPicker/ConsolidationModelPicker'
import { DiffPreview } from './components/DiffPreview/DiffPreview'
import { IssueDetailPanel } from './components/IssueDetailPanel/IssueDetailPanel'
import { ReportView } from './components/ReportView/ReportView'
import { ModelSelector } from './components/ModelSelector/ModelSelector'
import { PromptInput } from './components/PromptInput/PromptInput'
import { ReviewStatusPanel } from './components/ReviewStatusPanel/ReviewStatusPanel'
import { ScenarioHintInput } from './components/ScenarioHintInput/ScenarioHintInput'
import { SkillSelector } from './components/SkillSelector/SkillSelector'
import { SummaryPanel } from './components/SummaryPanel/SummaryPanel'
import { Button } from './components/ui/Button'
import { applyFix } from './core/fixApplier/applyFix'
import { generateDiff, type DiffResult } from './core/fixApplier/generateDiff'
import { DEFAULT_MODELS } from './core/modelProvider/providerAdapter'
import { runReview } from './core/orchestrator/runReview'
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
  const problems = actions.length > 0
    ? actions.map((action) => {
        const nature = action.nature ? `［${NATURE_TEXT[action.nature] ?? action.nature}］` : ''
        const relation = action.position_relation === 'joint' ? '（多处联合构成）' : ''
        const grouping = action.grouping_logic ? `\n   归组逻辑：${action.grouping_logic}` : ''
        const plan = fixPlanFor(action.priority)
        const fixText = plan
          ? plan.edits.length > 0
            ? `\n   建议改法（${plan.apply_mode === 'group' ? '需整组应用' : '每处可单独应用'}）：\n${plan.edits.map((edit) => `   - 改前：${edit.before_text.slice(0, 80)}\n     改后：${edit.after_text.slice(0, 80)}\n     说明：${edit.note}`).join('\n')}`
            : `\n   修复说明：${plan.no_fix_reason ?? '需要业务决策，无法给出文字级修复。'}`
          : ''
        return `${action.priority}. **${action.action_summary}** ${nature}${relation}\n   原因：${action.why}${grouping}${fixText}`
      }).join('\n\n')
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

  return `# Butler 审查报告：${title}

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

## 总体评估

${report.prescription.overall_assessment}

## 主要问题

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
    if (selectedSkillsNeedModel && selectedModelCount < 2) {
      setError('包含语义判断的审查需要选择 2-3 个检查官模型。')
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

  const exportReportJson = () => {
    if (!report) return
    const date = localDateForFilename(report.meta.timestamp)
    const summary = promptSummaryForFilename(targetSp, report)
    downloadTextFile(
      `butler-report-${date}-${summary}.json`,
      `${JSON.stringify(report, null, 2)}\n`,
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
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1540px] items-center gap-3 px-4 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-950 text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-normal text-slate-950">Butler</h1>
            <p className="text-sm text-slate-500">System Prompt 审查工作台</p>
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
          />
          <ConsolidationModelPicker
            models={models}
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
          <SummaryPanel
            report={report}
            selectedSkills={selectedSkills}
            selectedModelCount={selectedModelCount}
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
            />
          ) : null}

          <section className="rounded-lg border border-slate-200 bg-white p-4">
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
    </main>
  )
}

export default App
