import type {
  CandidateIssueGroup,
  ConfidenceDisplay,
  EvidenceType,
  Fix,
  Issue,
  IssueCategory,
  IssueGroup,
  IssueSeverity,
  ReviewConsolidationResult,
  SeverityDisplay,
  SkillDefinition,
} from '../../types/reviewReport.types'

interface DeduplicationResult {
  groups: IssueGroup[]
  candidateGroups: CandidateIssueGroup[]
}

const severityRank: Record<IssueSeverity, number> = {
  critical: 3,
  major: 2,
  minor: 1,
  info: 0,
}

function severityDisplay(severity: IssueSeverity | undefined): SeverityDisplay {
  if (severity === 'critical') return '严重'
  if (severity === 'info') return '轻微'
  return '中等'
}

function strongerSeverity(a: Issue, b: Issue) {
  return severityRank[b.severity ?? 'major'] - severityRank[a.severity ?? 'major']
}

function evidenceConfidence(evidence: EvidenceType | undefined, issue: Issue): ConfidenceDisplay {
  if (evidence === 'explicit_conflict' || issue.consensus === 'confirmed' || issue.consensus === 'static_check_deterministic') {
    return '高'
  }
  if (issue.consensus === 'single_model_flag' && !issue.domain_specific) {
    return '仅供参考'
  }
  if (evidence === 'stylistic_judgment') return '仅供参考'
  return '中'
}

function strongestConfidence(values: ConfidenceDisplay[]): ConfidenceDisplay {
  if (values.includes('高')) return '高'
  if (values.includes('中')) return '中'
  return '仅供参考'
}

function stripFix(fix: Fix | null): Fix | null {
  if (!fix) return null
  return {
    action: fix.action,
    target: fix.target,
    from: fix.from,
    to: fix.to,
    content: fix.content,
  }
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokenSet(value: string) {
  return new Set(normalizeText(value).split(/\s+/).filter(Boolean))
}

function jaccard(a: string, b: string) {
  const left = tokenSet(a)
  const right = tokenSet(b)
  if (left.size === 0 || right.size === 0) return 0
  let overlap = 0
  left.forEach((item) => {
    if (right.has(item)) overlap += 1
  })
  return overlap / (left.size + right.size - overlap)
}

function locationSignature(issue: Issue) {
  return [
    issue.location.anchor_before,
    issue.location.matched_text ?? '',
    issue.location.anchor_after,
  ].join('|')
}

function locationsDistinct(issues: Issue[]) {
  const signatures = new Set(issues.map(locationSignature))
  return signatures.size === issues.length
}

function locationOverlap(a: Issue, b: Issue) {
  const aText = normalizeText(`${a.location.anchor_before} ${a.location.matched_text ?? ''} ${a.location.anchor_after}`)
  const bText = normalizeText(`${b.location.anchor_before} ${b.location.matched_text ?? ''} ${b.location.anchor_after}`)
  return jaccard(aText, bText)
}

function skillTitle(skillMap: Map<string, SkillDefinition>, skillId: string) {
  // 禁止内部代号（如 consolidation_review）直接暴露给用户
  if (skillId === 'consolidation_review') return '复核阶段补充发现'
  return skillMap.get(skillId)?.title ?? '其他发现'
}

function groupSeverity(issues: Issue[]) {
  return [...issues].sort(strongerSeverity)[0]?.severity ?? 'major'
}

function makeLocations(issues: Issue[]) {
  return issues.map((issue, index) => ({
    marker_index: index + 1,
    anchor_before: issue.location.anchor_before,
    anchor_after: issue.location.anchor_after,
    matched_text: issue.location.matched_text,
    ambiguous: issue.location.ambiguous,
    source_issue_id: issue.id,
    // 每处位置携带自己的具体解释，合并后不丢失“为什么这里有问题”
    reason: issue.description,
  }))
}

/**
 * 多位置合并组的整合描述：不再用“在多个位置命中，展开查看”这种无信息量占位语，
 * 而是把各处的具体判断整合成可读的说明。
 */
function mergedDescription(skillLabel: string, issues: Issue[]) {
  const uniqueDescriptions = [...new Set(issues.map((issue) => issue.description.trim()).filter(Boolean))]
  if (uniqueDescriptions.length === 1) return uniqueDescriptions[0]
  const lines = uniqueDescriptions.slice(0, 4).map((text, index) => `${index + 1}. ${text}`)
  const suffix = uniqueDescriptions.length > 4 ? `\n…及其余 ${uniqueDescriptions.length - 4} 处同类情况。` : ''
  return `${skillLabel}在以下几处分别存在具体问题：\n${lines.join('\n')}${suffix}`
}

function makeFixItems(issues: Issue[]) {
  return issues.map((issue, index) => ({
    marker_index: index + 1,
    fix: stripFix(issue.fix),
    fix_requires_review: true as const,
  }))
}

function rawModelOutputIdsFromIssues(issues: Issue[]) {
  return [...new Set(issues.flatMap((issue) => issue.raw_model_output_ids ?? []))]
}

function rawModelOutputIdsFromGroups(groups: IssueGroup[]) {
  return [...new Set(groups.flatMap((group) => group.raw_model_output_ids ?? []))]
}

function profileConflictFromIssues(issues: Issue[]) {
  const conflictDetails = [...new Set(
    issues
      .filter((issue) => issue.profile_conflict)
      .map((issue) => issue.profile_conflict_detail)
      .filter((detail): detail is string => Boolean(detail)),
  )]
  if (conflictDetails.length === 0 && !issues.some((issue) => issue.profile_conflict)) return {}
  return {
    profile_conflict: true as const,
    profile_conflict_detail: conflictDetails.join('\n') || '该问题与文档画像存在矛盾，需要人工复核画像。',
  }
}

function profileConflictFromGroups(groups: IssueGroup[]) {
  const conflictDetails = [...new Set(
    groups
      .filter((group) => group.profile_conflict)
      .map((group) => group.profile_conflict_detail)
      .filter((detail): detail is string => Boolean(detail)),
  )]
  if (conflictDetails.length === 0 && !groups.some((group) => group.profile_conflict)) return {}
  return {
    profile_conflict: true as const,
    profile_conflict_detail: conflictDetails.join('\n') || '该归纳问题与文档画像存在矛盾，需要人工复核画像。',
  }
}

function makeGroup(params: {
  id: string
  mergeType: IssueGroup['merge_type']
  title: string
  issues: Issue[]
  description?: string
}): IssueGroup {
  const relatedSkillIds = [...new Set(params.issues.map((issue) => issue.skill_id))]
  const category = params.issues[0]?.category ?? 'clarity'
  const confidence = strongestConfidence(
    params.issues.map((issue) => evidenceConfidence(issue.evidence_type, issue)),
  )

  return {
    id: params.id,
    merge_type: params.mergeType,
    title: params.title,
    related_skill_ids: relatedSkillIds,
    category,
    severity_display: severityDisplay(groupSeverity(params.issues)),
    confidence_display: confidence,
    domain_specific: params.issues.some((issue) => issue.domain_specific),
    locations: makeLocations(params.issues),
    description: params.description ?? params.issues[0]?.description ?? params.title,
    raw_model_output_ids: rawModelOutputIdsFromIssues(params.issues),
    ...profileConflictFromIssues(params.issues),
    fix_items: makeFixItems(params.issues),
  }
}

function findDuplicatePair(issues: Issue[]) {
  let bestPair: [Issue, Issue] | null = null
  let bestScore = 0

  for (let i = 0; i < issues.length; i += 1) {
    for (let j = i + 1; j < issues.length; j += 1) {
      const left = issues[i]
      const right = issues[j]
      if (!left || !right || left.skill_id === right.skill_id) continue
      const locScore = locationOverlap(left, right)
      const descScore = jaccard(left.description, right.description)
      const score = locScore * 0.6 + descScore * 0.4
      if (locScore >= 0.55 && descScore >= 0.35 && score > bestScore) {
        bestScore = score
        bestPair = [left, right]
      }
    }
  }

  return bestPair
}

function findPotentialSystemicGroups(groups: IssueGroup[]): CandidateIssueGroup[] {
  const byCategory = new Map<IssueCategory, IssueGroup[]>()
  groups.forEach((group) => {
    const items = byCategory.get(group.category) ?? []
    items.push(group)
    byCategory.set(group.category, items)
  })

  const candidates: CandidateIssueGroup[] = []
  byCategory.forEach((items, category) => {
    const highEnough = items.filter((item) => item.confidence_display !== '仅供参考')
    if (highEnough.length >= 3) {
      candidates.push({
        id: `candidate-${category}`,
        category,
        issue_group_ids: highEnough.slice(0, 5).map((item) => item.id),
      })
    }
  })
  return candidates
}

export function deduplicateIssues(issues: Issue[], skills: SkillDefinition[]): DeduplicationResult {
  const skillMap = new Map(skills.map((skill) => [skill.id, skill]))
  const foundIssues = issues.filter((issue) => issue.status === 'found')
  const groups: IssueGroup[] = []
  const used = new Set<Issue>()

  const bySkill = new Map<string, Issue[]>()
  foundIssues.forEach((issue) => {
    const items = bySkill.get(issue.skill_id) ?? []
    items.push(issue)
    bySkill.set(issue.skill_id, items)
  })

  bySkill.forEach((skillIssues, skillId) => {
    if (skillIssues.length > 1 && locationsDistinct(skillIssues)) {
      skillIssues.forEach((issue) => used.add(issue))
      groups.push(makeGroup({
        id: `group-${skillId}`,
        mergeType: 'same_skill_multi_location',
        title: skillTitle(skillMap, skillId),
        issues: skillIssues,
        description: mergedDescription(skillTitle(skillMap, skillId), skillIssues),
      }))
    }
  })

  const remaining = foundIssues.filter((issue) => !used.has(issue))
  while (remaining.length > 0) {
    const pair = findDuplicatePair(remaining)
    if (!pair) break
    pair.forEach((issue) => used.add(issue))
    pair.forEach((issue) => {
      const index = remaining.indexOf(issue)
      if (index >= 0) remaining.splice(index, 1)
    })
    const chosen = [...pair].sort((a, b) => b.description.length - a.description.length)[0]
    groups.push({
      ...makeGroup({
      id: `group-duplicate-${groups.length + 1}`,
      mergeType: 'duplicate_content_merge',
      title: chosen.description,
      issues: [chosen],
      description: `${chosen.description} 同时触发：${pair.map((issue) => skillTitle(skillMap, issue.skill_id)).join('、')}。`,
      }),
      related_skill_ids: [...new Set(pair.map((issue) => issue.skill_id))],
      raw_model_output_ids: rawModelOutputIdsFromIssues(pair),
      ...profileConflictFromIssues(pair),
    })
  }

  foundIssues
    .filter((issue) => !used.has(issue))
    .forEach((issue) => {
      groups.push(makeGroup({
        id: `group-${issue.skill_id}-${issue.id}`,
        mergeType: 'single',
        title: skillTitle(skillMap, issue.skill_id),
        issues: [issue],
      }))
    })

  return {
    groups,
    candidateGroups: findPotentialSystemicGroups(groups),
  }
}

function reindexGroup(group: IssueGroup): IssueGroup {
  const locations = group.locations.map((location, index) => ({
    ...location,
    marker_index: index + 1,
  }))
  const fixByOldIndex = new Map(group.fix_items.map((item) => [item.marker_index, item]))
  const fix_items = group.locations.map((location, index) => ({
    marker_index: index + 1,
    fix: fixByOldIndex.get(location.marker_index)?.fix ?? null,
    fix_requires_review: true as const,
  }))

  return {
    ...group,
    locations,
    fix_items,
  }
}

function synthesizeGroup(params: {
  id: string
  title: string
  groups: IssueGroup[]
}): IssueGroup {
  const locations = params.groups.flatMap((group) => group.locations)
  const fixItems = params.groups.flatMap((group) => group.fix_items)
  const relatedSkillIds = [...new Set(params.groups.flatMap((group) => group.related_skill_ids))]
  const severityOrder: SeverityDisplay[] = ['轻微', '中等', '严重']
  const confidenceOrder: ConfidenceDisplay[] = ['仅供参考', '中', '高']
  const strongestSeverity = [...params.groups].sort(
    (a, b) => severityOrder.indexOf(b.severity_display) - severityOrder.indexOf(a.severity_display),
  )[0]?.severity_display ?? '中等'
  const strongestConfidence = [...params.groups].sort(
    (a, b) => confidenceOrder.indexOf(b.confidence_display) - confidenceOrder.indexOf(a.confidence_display),
  )[0]?.confidence_display ?? '中'

  return reindexGroup({
    id: params.id,
    merge_type: 'systemic_synthesis',
    title: params.title,
    related_skill_ids: relatedSkillIds,
    category: params.groups[0]?.category ?? 'clarity',
    severity_display: strongestSeverity,
    confidence_display: strongestConfidence,
    domain_specific: params.groups.some((group) => group.domain_specific),
    locations,
    description: `基于以下${locations.length}处线索形成的归纳性问题。`,
    raw_model_output_ids: rawModelOutputIdsFromGroups(params.groups),
    ...profileConflictFromGroups(params.groups),
    fix_items: fixItems,
  })
}

export function mergeConsolidationIntoGroups(params: {
  groups: IssueGroup[]
  consolidation: ReviewConsolidationResult
  skills: SkillDefinition[]
}): IssueGroup[] {
  let finalGroups = [...params.groups]

  params.consolidation.synthesis_results.forEach((result) => {
    if (!result.has_common_root_cause || !result.synthesized_title) return
    const memberIds = new Set(result.member_issue_ids ?? [])
    if (memberIds.size === 0) return
    const members = finalGroups.filter((group) => memberIds.has(group.id))
    if (members.length < 2) return
    finalGroups = finalGroups.filter((group) => !memberIds.has(group.id))
    finalGroups.push(synthesizeGroup({
      id: `systemic-${result.candidate_group_id}`,
      title: result.synthesized_title,
      groups: members,
    }))
  })

  if (params.consolidation.new_issues.length > 0) {
    finalGroups = [
      ...finalGroups,
      ...deduplicateIssues(params.consolidation.new_issues, params.skills).groups,
    ]
  }

  return finalGroups
}
