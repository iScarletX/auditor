import { ChevronDown, ChevronRight, MapPin } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { IssueGroup } from '../../types/reviewReport.types'
import { textSimilarity } from '../../core/orchestrator/issueSimilarity'
import { IssueCard } from '../IssueCard/IssueCard'

interface IssueTabsProps {
  issues: IssueGroup[]
  onOpenIssue: (issue: IssueGroup) => void
}

interface LocationCluster {
  key: string
  snippet: string
  representativeText: string
  issues: IssueGroup[]
  isGlobal: boolean
}

function primaryLocationText(issue: IssueGroup) {
  const location = issue.locations[0]
  if (!location) return ''
  return [location.anchor_before, location.matched_text ?? '', location.anchor_after]
    .filter(Boolean)
    .join(' ')
    .trim()
}

function snippetFor(issue: IssueGroup) {
  const location = issue.locations[0]
  if (!location) return ''
  const matched = (location.matched_text ?? '').trim()
  if (matched) return matched.length > 120 ? `${matched.slice(0, 120)}…` : matched
  const before = location.anchor_before.trim()
  const after = location.anchor_after.trim()
  const combined = `${before} … ${after}`.trim()
  return combined.length > 120 ? `${combined.slice(0, 120)}…` : combined
}

const CLUSTER_SIMILARITY_THRESHOLD = 0.6

/**
 * 按“文档中的位置”聚合，而不是按检查项聚合：
 * 同一段原文只出现一次，其下列出所有指向这个位置的 issue（无论来自哪个检查项）。
 */
function clusterByLocation(issues: IssueGroup[]): LocationCluster[] {
  const clusters: LocationCluster[] = []
  const globalCluster: LocationCluster = {
    key: 'global',
    snippet: '',
    representativeText: '',
    issues: [],
    isGlobal: true,
  }

  issues.forEach((issue) => {
    const locationText = primaryLocationText(issue)
    if (!locationText) {
      globalCluster.issues.push(issue)
      return
    }
    const existing = clusters.find(
      (cluster) => textSimilarity(cluster.representativeText, locationText) >= CLUSTER_SIMILARITY_THRESHOLD,
    )
    if (existing) {
      existing.issues.push(issue)
      return
    }
    clusters.push({
      key: issue.id,
      snippet: snippetFor(issue),
      representativeText: locationText,
      issues: [issue],
      isGlobal: false,
    })
  })

  if (globalCluster.issues.length > 0) clusters.push(globalCluster)
  return clusters
}

export function IssueTabs({ issues, onOpenIssue }: IssueTabsProps) {
  const clusters = useMemo(() => clusterByLocation(issues), [issues])
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  return (
    <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-slate-950">检测细节（按文档位置组织）</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          同一段原文只出现一次，展开后可以看到这一处值得关注的几点。
        </p>
      </div>

      {clusters.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
          没有需要展示的检测细节
        </div>
      ) : (
        <div className="space-y-3">
          {clusters.map((cluster) => {
            const expanded = expandedKey === cluster.key
            return (
              <article key={cluster.key} className="rounded-lg border border-slate-200 bg-white">
                <button
                  type="button"
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
                  onClick={() => setExpandedKey(expanded ? null : cluster.key)}
                >
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    {cluster.isGlobal ? (
                      <p className="text-sm font-medium leading-6 text-slate-900">整体层面的观察</p>
                    ) : (
                      <p className="line-clamp-2 text-sm leading-6 text-slate-900">
                        「{cluster.snippet}」
                      </p>
                    )}
                    <p className="mt-1 text-xs text-slate-500">
                      {expanded ? '收起' : '这一处有值得关注的几点，点击展开'}
                    </p>
                  </div>
                  {expanded ? (
                    <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-slate-500" />
                  ) : (
                    <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-500" />
                  )}
                </button>
                {expanded ? (
                  <div className="space-y-3 border-t border-slate-100 px-4 py-3">
                    {cluster.issues.map((issue) => (
                      <IssueCard key={issue.id} issue={issue} onOpen={onOpenIssue} />
                    ))}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
