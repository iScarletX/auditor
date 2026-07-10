import { cosineSimilarity, getEmbeddings, SEMANTIC_DUPLICATE_THRESHOLD } from './embeddingClient'
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

// ============ S0: 稳定指纹机制(SARIF fingerprint 范式) ============
// 目的:让"同一位置+同一类别"的发现无论描述用词差异多大都能被认出是同一问题,
// 解决"同一雷被7个检查项各报一次却因描述不像而合并失败"。

// 位置锚点归一化:取锚点与命中文本的紧凑形式,容忍空白/标点差异
function locationAnchorKey(issue: Issue): string {
  const before = normalizeText(issue.location.anchor_before ?? '').slice(-24)
  const matched = normalizeText(issue.location.matched_text ?? '').slice(0, 40)
  const after = normalizeText(issue.location.anchor_after ?? '').slice(0, 24)
  // 命中文本是最强锚点;无命中文本时回退到前后锚点组合
  return matched.length >= 4 ? `m:${matched}` : `c:${before}~${after}`
}

// 精确指纹:位置 + 类别 + 命中原文片段。用于"当次跑测内去重"
export function preciseFingerprint(issue: Issue): string {
  return `${issue.category}::${locationAnchorKey(issue)}`
}

// 模糊指纹:仅位置行范围 + 类别(不含具体片段)。用于"跨版本 baseline diff",容忍行号漂移与文字微调
export function partialFingerprint(issue: Issue): string {
  const line = issue.location.line_range ? issue.location.line_range[0] : ''
  const before = normalizeText(issue.location.anchor_before ?? '').slice(-16)
  return `${issue.category}::L${line}::${before}`
}

// 两条 issue 是否指向同一问题(指纹判定,优先于相似度)
function sameFingerprint(a: Issue, b: Issue): boolean {
  return preciseFingerprint(a) === preciseFingerprint(b)
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

/**
 * 体验改进：中断/失败时的降级快照专用——把尚未去重/未经B1B2把关的原始found issue
 * 各自包装成一条独立 IssueGroup，不做任何合并/去重计算，保证即使中断也能拿到已发现的问题，
 * 而不是因为还没跑到去重这一步就把已发现的东西丢得一干二净。
 */
export function issuesToRawGroups(issues: Issue[]): IssueGroup[] {
  return issues
    .filter((issue) => issue.status === 'found')
    .map((issue, index) => ({
      id: issue.id || `raw-${index}`,
      merge_type: 'single' as IssueGroup['merge_type'],
      title: issue.description.split('\n')[0].slice(0, 60),
      related_skill_ids: [issue.skill_id],
      category: issue.category,
      severity_display: severityDisplay(issue.severity),
      confidence_display: evidenceConfidence(issue.evidence_type, issue),
      domain_specific: Boolean(issue.domain_specific),
      locations: makeLocations([issue]),
      description: issue.description,
      raw_model_output_ids: issue.raw_model_output_ids ?? [],
      ...profileConflictFromIssues([issue]),
      fix_items: makeFixItems([issue]),
    }))
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

// 第3级兼底用的相似度查询器:传入 issue 数组与对应 embedding,按引用返回两条 issue 的余弦相似度。
// 算不到(无embedding/不在表中)时返回 null,调用方应降级为仅用jaccard。
export type SemanticSimilarityLookup = (a: Issue, b: Issue) => number | null

function findDuplicatePair(issues: Issue[], semanticLookup?: SemanticSimilarityLookup) {
  let bestPair: [Issue, Issue] | null = null
  let bestScore = 0

  for (let i = 0; i < issues.length; i += 1) {
    for (let j = i + 1; j < issues.length; j += 1) {
      const left = issues[i]
      const right = issues[j]
      if (!left || !right || left.skill_id === right.skill_id) continue
      // ★ S0 第1级:指纹优先——同一位置+同一类别直接判定为同一问题,
      // 不论描述用词差异多大(解决"同雷多报"但描述不像导致合并失败)。
      if (sameFingerprint(left, right)) {
        return [left, right]
      }
      // ★ S0 第2级:embedding 语义相似度兼底。
      // 修正记录(2026-07-08):最初设计要求"位置先重叠才embedding",但这与 embedding 存在的目的自相矛皾:
      // embedding 正是要救"位置摘录完全不重叠(同一矛盞的两半边各摘一句)但实为同一问题"的情况，
      // 加上位置重叠门槛反而把这种真实情况挡在外面(实测系统中证实一直未触发)。
      // 现去除该门槛,直接依赖语义相似度阈值本身的区分力(实测:不相关项 0.20-0.28,同问题不同表述 0.70-0.93,
      // 安全边界宽达0.4+,无需额外位置前提)。
      if (semanticLookup) {
        const semScore = semanticLookup(left, right)
        if (semScore !== null && semScore >= SEMANTIC_DUPLICATE_THRESHOLD) {
          return [left, right]
        }
      }
      // 回退:位置重叠+描述相似度加权(原有机制,处理指纹不同但实为同一问题的情况)
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

// ============ S2: 位置归堆(cross_skill_same_location) ============
// 目的：把「去重后剩余的 issue 里，来自不同检查项但指向同一段原文的多个独立发现」
// 聚合成一张卡（卡内列多个子发现 + 各自的 reason），而不是散成多条展示。
// 策略：Union-Find 传递闭包——A-B 位置重叠、B-C 位置重叠 → A/B/C 同组（无需 A-C 直接重叠）。
// 阈值：locationOverlap >= 0.40（仅判「同一区域」，比 duplicate_content_merge 的 0.55 宽松；
//       不要求描述相似，因为这类 issue 正是「同位置、不同角度的独立分析」）。

const LOCATION_CLUSTER_THRESHOLD = 0.40

/** 简易 Union-Find（非递归路径压缩版，适配小数组） */
function makeUnionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i)
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]! // 路径减半
      x = parent[x]!
    }
    return x
  }
  function union(x: number, y: number) {
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent[rx] = ry
  }
  function collectGroups(): Map<number, number[]> {
    const map = new Map<number, number[]>()
    for (let i = 0; i < n; i += 1) {
      const root = find(i)
      const members = map.get(root) ?? []
      members.push(i)
      map.set(root, members)
    }
    return map
  }
  return { find, union, collectGroups }
}

/**
 * 对剩余 issue 做位置聚类，返回「需要归堆」的分组（每组 >= 2 条，且来自不同检查项）。
 * 同一检查项内部多条 issue 的情况，交给下游 same_skill_multi_location 逻辑处理，这里跳过。
 */
function findLocationClusters(issues: Issue[]): Issue[][] {
  const n = issues.length
  if (n < 2) return []

  const uf = makeUnionFind(n)

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = issues[i]!
      const b = issues[j]!
      // 同一检查项内部不在这里处理
      if (a.skill_id === b.skill_id) continue
      if (locationOverlap(a, b) >= LOCATION_CLUSTER_THRESHOLD) {
        uf.union(i, j)
      }
    }
  }

  const result: Issue[][] = []
  uf.collectGroups().forEach((indices) => {
    if (indices.length < 2) return
    const cluster = indices.map((i) => issues[i]!)
    // 过滤掉「所有 issue 都来自同一检查项」的分组（那是 same_skill_multi_location 的活）
    const distinctSkills = new Set(cluster.map((issue) => issue.skill_id))
    if (distinctSkills.size < 2) return
    result.push(cluster)
  })

  return result
}

/**
 * 为跨检查项归堆组生成标题：取最长的 matched_text 片段作为位置代表。
 */
function crossSkillGroupTitle(issues: Issue[]): string {
  const texts = issues
    .map((issue) => (issue.location.matched_text ?? issue.location.anchor_before ?? '').trim().slice(0, 30))
    .filter(Boolean)
  const longest = texts.reduce((best, t) => (t.length > best.length ? t : best), '')
  return longest ? `「${longest}」的多角度问题` : '同一位置的多角度问题'
}

/**
 * 为跨检查项归堆组生成 description：列出各检查项标题 + 各自的具体判断，
 * 便于用户一眼知道「哪几个检查项在这里各说了什么」。
 */
function crossSkillGroupDescription(issues: Issue[], skillMap: Map<string, SkillDefinition>): string {
  const lines = issues.map((issue) => {
    const title = skillTitle(skillMap, issue.skill_id)
    return `【${title}】${issue.description.trim()}`
  })
  return lines.join('\n')
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

/**
 * S0 第2级兼底:为一组 issue 批量取 embedding，构建可供 findDuplicatePair 查询的相似度表。
 * 无 apiKey 或请求失败时静默返回 null，调用方降级为仅精确指纹+jaccard，不中断主流程。
 */
// 优先取"原文引用片段"(matched_text)而非整段description。
// 实测发现:整段描述混杂分析框架文字("歧义表达""内部矛皾"等)会稀释核心事实信号,
// 导致同一雷的不同表述相似度只在 0.58-0.72;只取原文引用句时可升至 0.70-0.93。
function embeddingTextFor(issue: Issue): string {
  const anchorBefore = issue.location.anchor_before ?? ''
  const matched = issue.location.matched_text ?? ''
  const anchorAfter = issue.location.anchor_after ?? ''
  const anchorText = `${anchorBefore} ${matched} ${anchorAfter}`.trim()
  // 原文引用足够有信息量时优先用它;否则回退到description(仍比不去重好)
  return anchorText.length >= 8 ? anchorText : issue.description
}

async function buildSemanticLookup(
  issues: Issue[],
  apiKey: string | null,
): Promise<SemanticSimilarityLookup | undefined> {
  if (!apiKey || issues.length < 2) return undefined
  const texts = issues.map((issue) => embeddingTextFor(issue))
  const vectors = await getEmbeddings(texts, { apiKey })
  if (!vectors) return undefined // 静默降级:网络失败/无key时不阻塞主流程

  const indexOf = new Map(issues.map((issue, i) => [issue, i]))
  return (a, b) => {
    const ia = indexOf.get(a)
    const ib = indexOf.get(b)
    if (ia === undefined || ib === undefined) return null
    const va = vectors[ia]
    const vb = vectors[ib]
    if (!va || !vb) return null
    return cosineSimilarity(va, vb)
  }
}

export async function deduplicateIssues(
  issues: Issue[],
  skills: SkillDefinition[],
  options?: { embeddingApiKey?: string | null },
): Promise<DeduplicationResult> {
  const skillMap = new Map(skills.map((skill) => [skill.id, skill]))
  const foundIssues = issues.filter((issue) => issue.status === 'found')
  const groups: IssueGroup[] = []
  const used = new Set<Issue>()
  const semanticLookup = await buildSemanticLookup(foundIssues, options?.embeddingApiKey ?? null)

  // ★ 修正记录(2026-07-08):原来先按skill_id分组打包(same_skill_multi_location)、后才跨检查项比对。
  // 真实运行中发现:若同一检查项自己内部已报了多个不同位置的issue,会被早早打包并标记used,
  // 导致它实际与其他检查项的issue语义相似度高达0.78+也无法再参与比对(早已被锁死)。
  // 现改为先跨检查项比对(指纹/embedding/jaccard三级),再处理同检查项内部剩余的位置分组。
  // 安全性:findDuplicatePair 内部已显式跳过 left.skill_id === right.skill_id 的对,因此跨检查项比对
  // 不会干扰后面"同检查项内部多位置"的打包逻辑。
  const crossSkillRemaining = [...foundIssues]
  while (crossSkillRemaining.length > 0) {
    const pair = findDuplicatePair(crossSkillRemaining, semanticLookup)
    if (!pair) break
    pair.forEach((issue) => used.add(issue))
    pair.forEach((issue) => {
      const index = crossSkillRemaining.indexOf(issue)
      if (index >= 0) crossSkillRemaining.splice(index, 1)
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

  // ★ S2: cross_skill_same_location 位置归堆
  // 对跨检查项去重后的剩余 issue，按位置相似度（Union-Find 传递闭包）聚类。
  // 同一位置被多个不同检查项发现的独立分析 → 合成一张卡，各自保留 reason，不强行合并成一条。
  const remainingAfterCross = foundIssues.filter((issue) => !used.has(issue))
  const locationClusters = findLocationClusters(remainingAfterCross)
  locationClusters.forEach((cluster, clusterIndex) => {
    cluster.forEach((issue) => used.add(issue))
    groups.push(makeGroup({
      id: `group-location-cluster-${clusterIndex + 1}`,
      mergeType: 'cross_skill_same_location',
      title: crossSkillGroupTitle(cluster),
      issues: cluster,
      description: crossSkillGroupDescription(cluster, skillMap),
    }))
  })

  // 跨检查项比对完成后,剩余未被归堆的issue再按skill_id分组。
  // 若同一检查项内部仍有多个不同位置的issue(真实不同的发现,非重复),打包展示。
  const remainingAfterCluster = foundIssues.filter((issue) => !used.has(issue))
  const bySkill = new Map<string, Issue[]>()
  remainingAfterCluster.forEach((issue) => {
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

  // 注:跨检查项比对已在上方 crossSkillRemaining 循环中一次性完成,此处不再重复。
  foundIssues
    .filter((issue) => !used.has(issue))
    .forEach((issue) => {
      // 若skill_id本身已以issue.id作为后缀结尾(如skill_id='05_robustness_injection_defense'、
      // issue.id='injection_defense'，是 LLM 填 issue.id 时取了 skill 名字的末段词根——实测很常见)，
      // 直接用skill_id就能完整表达，不再重复拼接issue.id，避免产生 `group-xxx-xxx` 这种双重词根的
      // 怪异id——这类id很容易让B2汇总阶段的LLM在引用related_issue_ids时“自作聊明”地简化掉重复部分，
      // 导致与真实id对不上、这条issue在前端展示时静默丢失。
      const groupId = issue.skill_id.endsWith(issue.id) || issue.id === issue.skill_id
        ? `group-${issue.skill_id}`
        : `group-${issue.skill_id}-${issue.id}`
      groups.push(makeGroup({
        id: groupId,
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

export async function mergeConsolidationIntoGroups(params: {
  groups: IssueGroup[]
  consolidation: ReviewConsolidationResult
  skills: SkillDefinition[]
  embeddingApiKey?: string | null
}): Promise<IssueGroup[]> {
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
    const newDedup = await deduplicateIssues(params.consolidation.new_issues, params.skills, {
      embeddingApiKey: params.embeddingApiKey,
    })
    finalGroups = [
      ...finalGroups,
      ...newDedup.groups,
    ]
  }

  return finalGroups
}
