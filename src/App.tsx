import { History, Play, RotateCcw, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ConsolidationPanel } from './components/ConsolidationPanel/ConsolidationPanel'
import { DiffPreview } from './components/DiffPreview/DiffPreview'
import { IssueList } from './components/IssueList/IssueList'
import { ModelSelector } from './components/ModelSelector/ModelSelector'
import { PromptInput } from './components/PromptInput/PromptInput'
import { ReviewProgress } from './components/ReviewProgress/ReviewProgress'
import { ScenarioHintInput } from './components/ScenarioHintInput/ScenarioHintInput'
import { SkillSelector } from './components/SkillSelector/SkillSelector'
import { SummaryPanel } from './components/SummaryPanel/SummaryPanel'
import { Button } from './components/ui/Button'
import { applyFix } from './core/fixApplier/applyFix'
import { generateDiff, type DiffResult } from './core/fixApplier/generateDiff'
import { DEFAULT_MODELS } from './core/modelProvider/providerAdapter'
import { runReview } from './core/orchestrator/runReview'
import { loadBuiltinSkills } from './core/skillLoader/loadBuiltinSkills'
import { loadUserSkills } from './core/skillLoader/loadUserSkills'
import { saveDraftRevision, listReviewRecords, saveReviewRecord } from './core/storage/indexedDbStore'
import { encryptAndStoreApiKey, loadDecryptedApiKey } from './core/storage/keyEncryption'
import {
  getStoredApiKeyMask,
  hasStoredEncryptedApiKey,
  loadModelPrefs,
  saveModelPrefs,
} from './core/storage/localStoragePrefs'
import type {
  Issue,
  ModelConfig,
  ReviewProgressEvent,
  ReviewReport,
  SkillDefinition,
} from './types/reviewReport.types'
import type { ReviewHistoryRecord } from './core/storage/indexedDbStore'

const SAMPLE_PROMPT = `你是一个客服助手，负责回答用户关于产品的问题。

用户会在对话框里直接输入他们的问题，你根据问题给出回答。

请输出包含标题、摘要、标签三个字段的内容，输出尽量简洁。`

function loadInitialModels() {
  const prefs = loadModelPrefs()
  const selectedPrefs = prefs?.filter((model) => model.provider === 'openrouter' && model.selected).slice(0, 3)
  if (selectedPrefs?.length) return selectedPrefs
  return DEFAULT_MODELS
}

function App() {
  const [targetSp, setTargetSp] = useState(SAMPLE_PROMPT)
  const [scenarioHint, setScenarioHint] = useState('')
  const [skills, setSkills] = useState<SkillDefinition[]>([])
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [models, setModels] = useState<ModelConfig[]>(loadInitialModels)
  const [hasApiKey, setHasApiKey] = useState(() => hasStoredEncryptedApiKey())
  const [apiKeyMask, setApiKeyMask] = useState(() => getStoredApiKeyMask())
  const [running, setRunning] = useState(false)
  const [events, setEvents] = useState<ReviewProgressEvent[]>([])
  const [streamIssues, setStreamIssues] = useState<Issue[]>([])
  const [report, setReport] = useState<ReviewReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<ReviewHistoryRecord[]>([])
  const [previewIssue, setPreviewIssue] = useState<Issue | null>(null)
  const [previewDiff, setPreviewDiff] = useState<DiffResult | null>(null)

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

  const selectedSkills = useMemo(
    () => skills.filter((skill) => selectedSkillIds.has(skill.id)),
    [skills, selectedSkillIds],
  )
  const selectedModelCount = models.filter((model) => model.selected).length
  const visibleIssues = report?.issues ?? streamIssues

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

  const startReview = async () => {
    if (running) return
    setError(null)
    setEvents([])
    setStreamIssues([])
    setReport(null)

    if (!targetSp.trim()) {
      setError('请先粘贴要审查的 System Prompt。')
      return
    }
    if (selectedSkills.length === 0) {
      setError('请至少选择一个 Skill。')
      return
    }
    if (selectedModelCount === 1) {
      const confirmed = window.confirm('仅选择1个模型时，LLM 判断都会被标记为单模型标记，建议至少选择2个模型。仍要继续吗？')
      if (!confirmed) return
    }

    setRunning(true)
    try {
      const apiKey = await loadDecryptedApiKey()
      const finalReport = await runReview({
        targetSp,
        scenarioHint,
        selectedSkills,
        selectedModels: models,
        apiKey,
        onProgress: (event) => {
          setEvents((current) => [...current, event])
          setStreamIssues((current) => [...current, ...event.issues])
        },
      })
      setReport(finalReport)
      await saveReviewRecord({
        id: crypto.randomUUID(),
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
    }
  }

  const previewFix = (issue: Issue) => {
    setPreviewIssue(issue)
    setPreviewDiff(generateDiff(targetSp, issue))
  }

  const confirmFix = async () => {
    if (!previewIssue) return
    try {
      const next = applyFix(targetSp, previewIssue, true)
      await saveDraftRevision({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        issueId: previewIssue.id,
        before: targetSp,
        after: next,
      })
      setTargetSp(next)
      setPreviewIssue(null)
      setPreviewDiff(null)
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : '应用修改失败')
    }
  }

  const loadHistoryRecord = (record: ReviewHistoryRecord) => {
    setTargetSp(record.targetSp)
    setScenarioHint(record.scenarioHint ?? record.report.meta.scenario_hint ?? '')
    setReport(record.report)
    setStreamIssues(record.report.issues)
    setEvents([])
    setError(null)
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1540px] flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-950 text-white">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-normal text-slate-950">Butler</h1>
              <p className="text-sm text-slate-500">System Prompt 审查工作台</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setTargetSp(SAMPLE_PROMPT)
                setScenarioHint('')
                setReport(null)
                setStreamIssues([])
              }}
            >
              <RotateCcw className="h-4 w-4" />
              示例
            </Button>
            <Button type="button" onClick={() => void startReview()} disabled={running}>
              <Play className="h-4 w-4" />
              {running ? '审查中' : '开始审查'}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1540px] gap-4 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-4">
          <PromptInput value={targetSp} onChange={setTargetSp} />
          <ScenarioHintInput value={scenarioHint} onChange={setScenarioHint} />
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          ) : null}
          <ConsolidationPanel consolidation={report?.consolidation ?? null} />
          <IssueList issues={visibleIssues} onPreviewFix={previewFix} />
        </div>

        <aside className="space-y-4">
          <SummaryPanel report={report} selectedSkills={selectedSkills} selectedModelCount={selectedModelCount} />
          <ModelSelector
            models={models}
            onChange={setModels}
            hasStoredApiKey={hasApiKey}
            apiKeyMask={apiKeyMask}
            onSaveApiKey={handleSaveApiKey}
            onLoadStoredApiKey={loadDecryptedApiKey}
          />
          <SkillSelector
            skills={skills}
            selectedIds={selectedSkillIds}
            onToggle={toggleSkill}
            onReplaceSelection={(ids) => setSelectedSkillIds(new Set(ids))}
            onSkillAdded={addUserSkill}
          />
          <ReviewProgress running={running} events={events} total={selectedSkills.length + 1} />

          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center gap-2">
              <History className="h-4 w-4 text-slate-500" />
              <h2 className="text-sm font-semibold text-slate-950">历史记录</h2>
            </div>
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">暂无历史记录</p>
            ) : (
              <div className="space-y-2">
                {history.slice(0, 8).map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    className="block w-full rounded-md border border-slate-200 px-3 py-2 text-left text-xs transition hover:bg-slate-50"
                    onClick={() => loadHistoryRecord(record)}
                  >
                    <div className="font-medium text-slate-900">{record.title}</div>
                    <div className="mt-1 text-slate-500">
                      {new Date(record.createdAt).toLocaleString()} · {record.report.issues.filter((issue) => issue.status === 'found').length} issues
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      <DiffPreview
        issue={previewIssue}
        diff={previewDiff}
        onConfirm={() => void confirmFix()}
        onCancel={() => {
          setPreviewIssue(null)
          setPreviewDiff(null)
        }}
      />
    </main>
  )
}

export default App
