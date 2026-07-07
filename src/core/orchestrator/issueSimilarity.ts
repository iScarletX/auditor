import type { Issue, IssueGroup } from '../../types/reviewReport.types'

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim()
}

function bigrams(value: string) {
  const normalized = normalizeText(value)
  if (normalized.length <= 1) return normalized ? [normalized] : []
  const result: string[] = []
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.push(normalized.slice(index, index + 2))
  }
  return result
}

function diceCoefficient(a: string, b: string) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.length === 0 || right.length === 0) return 0

  const rightCounts = new Map<string, number>()
  right.forEach((item) => {
    rightCounts.set(item, (rightCounts.get(item) ?? 0) + 1)
  })

  let overlap = 0
  left.forEach((item) => {
    const count = rightCounts.get(item) ?? 0
    if (count <= 0) return
    overlap += 1
    rightCounts.set(item, count - 1)
  })

  return (2 * overlap) / (left.length + right.length)
}

export function textSimilarity(a: string, b: string) {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const shorter = left.length < right.length ? left : right
  const longer = left.length < right.length ? right : left
  if (shorter.length >= 12 && longer.includes(shorter)) return 0.92
  return diceCoefficient(a, b)
}

export function issueLocationText(issue: Issue) {
  return [
    issue.location.anchor_before,
    issue.location.matched_text ?? '',
    issue.location.anchor_after,
  ].join(' ')
}

function matchedTextSimilarity(a: Issue, b: Issue) {
  return textSimilarity(a.location.matched_text ?? '', b.location.matched_text ?? '')
}

export function isSameConcreteIssue(
  a: Issue,
  b: Issue,
  options: { requireSameSkill?: boolean } = {},
) {
  const requireSameSkill = options.requireSameSkill ?? true
  if (requireSameSkill && a.skill_id !== b.skill_id) return false
  if (a.status !== 'found' || b.status !== 'found') return false

  const locationScore = textSimilarity(issueLocationText(a), issueLocationText(b))
  const matchedScore = matchedTextSimilarity(a, b)
  const descriptionScore = textSimilarity(a.description, b.description)
  const hasSpecificMatchedText = Math.min(
    normalizeText(a.location.matched_text ?? '').length,
    normalizeText(b.location.matched_text ?? '').length,
  ) >= 12

  return (
    (hasSpecificMatchedText && matchedScore >= 0.96 && descriptionScore >= 0.2)
    || (matchedScore >= 0.9 && descriptionScore >= 0.45)
    || (locationScore >= 0.82 && descriptionScore >= 0.55)
    || (locationScore >= 0.65 && descriptionScore >= 0.82)
  )
}

export function issueGroupLooksSimilar(issue: Issue, group: IssueGroup) {
  if (issue.status !== 'found') return false
  return group.locations.some((location) => {
    const groupLocationText = [
      location.anchor_before,
      location.matched_text ?? '',
      location.anchor_after,
    ].join(' ')
    const locationScore = textSimilarity(issueLocationText(issue), groupLocationText)
    const matchedScore = textSimilarity(issue.location.matched_text ?? '', location.matched_text ?? '')
    const descriptionScore = textSimilarity(issue.description, group.description)
    return (
      (matchedScore >= 0.9 && descriptionScore >= 0.45)
      || (locationScore >= 0.82 && descriptionScore >= 0.55)
      || (locationScore >= 0.65 && descriptionScore >= 0.82)
    )
  })
}
