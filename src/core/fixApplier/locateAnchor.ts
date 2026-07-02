import type { IssueLocation } from '../../types/reviewReport.types'

export interface AnchorLocationResult {
  ok: boolean
  start: number
  end: number
  reason?: string
}

function findAll(text: string, needle: string) {
  if (!needle) return []
  const indexes: number[] = []
  let index = text.indexOf(needle)
  while (index !== -1) {
    indexes.push(index)
    index = text.indexOf(needle, index + Math.max(needle.length, 1))
  }
  return indexes
}

export function locateAnchor(targetSp: string, location: IssueLocation): AnchorLocationResult {
  if (location.ambiguous) {
    return {
      ok: false,
      start: -1,
      end: -1,
      reason: '该 issue 标记为锚点不唯一，需要手动确认具体位置。',
    }
  }

  if (location.matched_text) {
    const matches = findAll(targetSp, location.matched_text)
    if (matches.length === 1) {
      return {
        ok: true,
        start: matches[0],
        end: matches[0] + location.matched_text.length,
      }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        start: -1,
        end: -1,
        reason: 'matched_text 在原文中出现多次，需要手动确认具体位置。',
      }
    }
  }

  const beforeMatches = findAll(targetSp, location.anchor_before)
  const candidates = beforeMatches
    .map((beforeIndex) => {
      const start = beforeIndex + location.anchor_before.length
      const end = location.anchor_after
        ? targetSp.indexOf(location.anchor_after, start)
        : start
      if (end === -1) return null
      return { start, end }
    })
    .filter((candidate): candidate is { start: number; end: number } => Boolean(candidate))

  if (candidates.length === 1) {
    return { ok: true, start: candidates[0].start, end: candidates[0].end }
  }

  return {
    ok: false,
    start: -1,
    end: -1,
    reason: candidates.length > 1 ? '锚点组合在原文中匹配到多处。' : '未能在原文中定位该锚点。',
  }
}
